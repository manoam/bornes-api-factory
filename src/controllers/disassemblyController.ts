import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';
import { logDisassemblyEvent } from '../services/disassemblyEventLog';
import { stockClientFor } from '../services/stockClient';
import {
  getBornesSnapshot,
  isConfigured as isBornesConfigured,
  type BorneRow,
} from '../services/bornesClient';
import { enrichRowsWithBornes } from '../services/borneEnrich';
import { publishEvent } from '../services/rabbitmqHttp';

/**
 * Demontages Factory V1.
 *
 * Simpler que la Reparation: pas de TESTING, pas de controles qualite,
 * une seule "colonne" de composants (recuperation, pas d'installation).
 *
 * Flow attendu :
 *   1. POST /disassemblies  { borneInternalNumber, reason }
 *      -> DRAFT, resolution de la borne (Factory / Bornes / unknown)
 *   2. GET /:id/suggestions
 *      -> retourne la composition Factory si connue, pour pre-remplir
 *   3. POST /:id/transition to=IN_PROGRESS
 *   4. POST /:id/components { productId, ..., disposition }  (repete)
 *      -> chaque ligne genere un mvt Stock IN (condition NEW/USED selon dispo)
 *   5. POST /:id/transition to=COMPLETED
 *      -> publie factory.disassemblies.completed
 *      -> Bornes archive la borne dans son parc
 */

const createSchema = z.object({
  borneInternalNumber: z.string().min(1, 'Numero de borne requis'),
  reason: z.string().optional().nullable(),
});

const updateSchema = z.object({
  reason: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const addComponentSchema = z.object({
  productId: z.string().min(1),
  productReference: z.string().min(1),
  serialNumber: z.string().optional().nullable(),
  quantity: z.number().int().positive().default(1),
  disposition: z.enum(['STOCK_NEW', 'STOCK_USED', 'TO_TEST', 'SCRAP']),
});

const transitionSchema = z.object({
  to: z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  reason: z.string().optional(),
});

const STATUS_VALUES = ['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

// ---------- LIST ----------

export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const statusRaw = req.query.status as string | undefined;
    const statusFilter = statusRaw
      ? statusRaw
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => (STATUS_VALUES as readonly string[]).includes(s))
      : undefined;
    const search = (req.query.search as string | undefined)?.trim() || undefined;
    const mine = req.query.mine === 'true' || req.query.mine === '1';
    const operatorId = mine
      ? req.user.id
      : ((req.query.operatorId as string | undefined)?.trim() || undefined);
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || '50', 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0);

    const baseWhere: any = {};
    if (operatorId) baseWhere.operatorId = operatorId;
    if (search) {
      baseWhere.OR = [
        { borneInternalNumber: { contains: search, mode: 'insensitive' } },
        { reason: { contains: search, mode: 'insensitive' } },
      ];
    }
    const listWhere: any = { ...baseWhere };
    if (statusFilter && statusFilter.length > 0) listWhere.status = { in: statusFilter };

    const [rows, total, statsRaw] = await Promise.all([
      prisma.disassembly.findMany({
        where: listWhere,
        include: { _count: { select: { components: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.disassembly.count({ where: listWhere }),
      prisma.disassembly.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const stats: Record<string, number> = {
      DRAFT: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    for (const s of statsRaw) stats[s.status] = s._count._all;

    const shaped = rows.map((r) => ({
      id: r.id,
      borneInternalNumber: r.borneInternalNumber,
      sourceApp: r.sourceApp,
      status: r.status,
      reason: r.reason,
      operatorName: r.operatorName,
      createdByName: r.createdByName,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      componentsCount: r._count.components,
    }));
    const enriched = await enrichRowsWithBornes(shaped);

    res.json({
      success: true,
      data: enriched,
      stats,
      pagination: { total, limit, offset },
    });
  } catch (err) {
    next(err);
  }
}

// ---------- GET ----------

export async function get(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const dis = await prisma.disassembly.findUnique({
      where: { id },
      include: { components: { orderBy: { createdAt: 'asc' } } },
    });
    if (!dis) throw new AppError('Demontage introuvable', 404);
    res.json({ success: true, data: dis });
  } catch (err) {
    next(err);
  }
}

// ---------- CREATE ----------

export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const body = createSchema.parse(req.body);
    const internal = body.borneInternalNumber.trim();

    // Resolution (meme logique que RepairOrder).
    let sourceApp = 'unknown';
    const localAssembly = await prisma.assemblyOrder.findFirst({
      where: { internalNumber: internal, status: 'COMPLETED' },
      select: { id: true },
    });
    if (localAssembly) sourceApp = 'factory';
    if (sourceApp === 'unknown' && isBornesConfigured()) {
      try {
        const snap = await getBornesSnapshot();
        if (snap.byInternal.has(internal)) sourceApp = 'bornes';
      } catch {
        /* ignore */
      }
    }

    const dis = await prisma.$transaction(async (tx) => {
      const created = await tx.disassembly.create({
        data: {
          borneInternalNumber: internal,
          sourceApp,
          reason: body.reason || null,
          createdById: req.user.id,
          createdByName: req.user.fullName || req.user.username,
        },
      });
      await logDisassemblyEvent(tx as any, created.id, 'STATUS_CHANGED', req.user, {
        from: null,
        to: 'DRAFT',
      });
      if (body.reason) {
        await logDisassemblyEvent(tx as any, created.id, 'REASON_UPDATED', req.user);
      }
      return created;
    });

    res.status(201).json({ success: true, data: dis });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}

// ---------- PATCH ----------

export async function update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const body = updateSchema.parse(req.body);
    const existing = await prisma.disassembly.findUnique({ where: { id } });
    if (!existing) throw new AppError('Demontage introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Demontage clos — modification impossible', 400);
    }

    const data: any = {};
    if (body.reason !== undefined) data.reason = body.reason;
    if (body.notes !== undefined) data.notes = body.notes;

    const dis = await prisma.$transaction(async (tx) => {
      const updated = await tx.disassembly.update({
        where: { id },
        data,
        include: { components: true },
      });
      if (body.reason !== undefined && body.reason !== existing.reason) {
        await logDisassemblyEvent(tx as any, id, 'REASON_UPDATED', req.user);
      }
      if (body.notes !== undefined && body.notes !== existing.notes) {
        await logDisassemblyEvent(tx as any, id, 'NOTES_UPDATED', req.user);
      }
      return updated;
    });

    res.json({ success: true, data: dis });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}

// ---------- COMPONENTS ----------

/**
 * POST /disassemblies/:id/components
 *
 * Cree une ligne recuperee + un mouvement Stock IN vers le site Atelier.
 * La condition Stock depend de la disposition:
 *   - STOCK_NEW  -> IN condition NEW
 *   - STOCK_USED -> IN condition USED
 *   - TO_TEST    -> IN condition USED, comment "a tester"
 *   - SCRAP      -> IN condition USED, comment "rebut"
 *
 * Si Stock est down, on cree quand meme la ligne cote Factory
 * (stockMovementId = null) et on log un warning.
 */
export async function addComponent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const body = addComponentSchema.parse(req.body);
    const existing = await prisma.disassembly.findUnique({ where: { id } });
    if (!existing) throw new AppError('Demontage introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Demontage clos — modification impossible', 400);
    }
    if (existing.status === 'DRAFT') {
      throw new AppError('Demarrer le demontage avant de recuperer des composants', 400);
    }

    const stock = stockClientFor(req.user.rawToken);
    let stockMovementId: string | null = null;
    try {
      const atelier = await stock.getAtelierSite();
      const condition: 'NEW' | 'USED' = body.disposition === 'STOCK_NEW' ? 'NEW' : 'USED';
      const suffix =
        body.disposition === 'STOCK_NEW'
          ? 'stock neuf'
          : body.disposition === 'STOCK_USED'
            ? 'stock occasion'
            : body.disposition === 'TO_TEST'
              ? 'a tester'
              : 'rebut';
      const movement = await stock.createMovement({
        productId: body.productId,
        type: 'IN',
        quantity: body.quantity,
        condition,
        movementDate: new Date().toISOString(),
        targetSiteId: atelier.id,
        comment: `Demontage ${existing.borneInternalNumber} — ${suffix}`,
        ...(body.serialNumber ? { serialNumbers: [body.serialNumber] } : {}),
      });
      stockMovementId = movement.id;
    } catch (err) {
      console.warn(
        '[disassemblies] Stock createMovement failed, keeping local record:',
        err instanceof Error ? err.message : String(err),
      );
    }

    const component = await prisma.$transaction(async (tx) => {
      const c = await tx.disassemblyComponent.create({
        data: {
          disassemblyId: id,
          productId: body.productId,
          productReference: body.productReference,
          serialNumber: body.serialNumber || null,
          quantity: body.quantity,
          disposition: body.disposition,
          stockMovementId,
        },
      });
      await logDisassemblyEvent(tx as any, id, 'COMPONENT_RECOVERED', req.user, {
        productRef: body.productReference,
        serialNumber: body.serialNumber || null,
        quantity: body.quantity,
        disposition: body.disposition,
        stockMovementId,
      });
      return c;
    });

    res.status(201).json({ success: true, data: component });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}

export async function removeComponent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const componentId = String(req.params.componentId);
    const component = await prisma.disassemblyComponent.findUnique({
      where: { id: componentId },
      include: { disassembly: true },
    });
    if (!component || component.disassemblyId !== id) {
      throw new AppError('Composant introuvable', 404);
    }
    if (
      component.disassembly.status === 'COMPLETED' ||
      component.disassembly.status === 'CANCELLED'
    ) {
      throw new AppError('Demontage clos — retrait impossible', 400);
    }

    // On ne re-inverse pas le mouvement Stock (idem RepairOrder).
    await prisma.$transaction(async (tx) => {
      await tx.disassemblyComponent.delete({ where: { id: component.id } });
      await logDisassemblyEvent(tx as any, id, 'COMPONENT_REVERTED', req.user, {
        productRef: component.productReference,
        serialNumber: component.serialNumber,
        stockMovementId: component.stockMovementId,
      });
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ---------- HISTORY ----------

export async function history(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const events = await prisma.disassemblyEvent.findMany({
      where: { disassemblyId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
}

// ---------- BORNE INFO ----------

export async function borneInfo(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const dis = await prisma.disassembly.findUnique({
      where: { id },
      select: { borneInternalNumber: true, sourceApp: true },
    });
    if (!dis) throw new AppError('Demontage introuvable', 404);

    const result: {
      internalNumber: string;
      sourceApp: string;
      factoryAssembly:
        | {
            id: string;
            model: string;
            completedAt: Date | null;
            components: {
              id: string;
              productId: string;
              productReference: string;
              serialNumber: string | null;
              quantity: number;
              installedAt: Date | null;
            }[];
          }
        | null;
      parcBorne: BorneRow | null;
      parcError: string | null;
    } = {
      internalNumber: dis.borneInternalNumber,
      sourceApp: dis.sourceApp,
      factoryAssembly: null,
      parcBorne: null,
      parcError: null,
    };

    const assembly = await prisma.assemblyOrder.findFirst({
      where: { internalNumber: dis.borneInternalNumber, status: 'COMPLETED' },
      include: {
        productionOrder: { select: { model: true } },
        components: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (assembly) {
      result.factoryAssembly = {
        id: assembly.id,
        model: assembly.productionOrder.model,
        completedAt: assembly.completedAt,
        components: assembly.components.map((c) => ({
          id: c.id,
          productId: c.productId,
          productReference: c.productReference,
          serialNumber: c.serialNumber,
          quantity: c.quantity,
          installedAt: c.installedAt,
        })),
      };
    }

    if (isBornesConfigured()) {
      try {
        const snap = await getBornesSnapshot();
        const found = snap.byInternal.get(dis.borneInternalNumber);
        if (found) result.parcBorne = found;
      } catch (err) {
        result.parcError = err instanceof Error ? err.message : String(err);
      }
    } else {
      result.parcError = 'API Bornes non configuree';
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ---------- SUGGESTIONS ----------

/**
 * GET /disassemblies/:id/suggestions
 *
 * Renvoie la composition Factory d'origine, moins les composants deja
 * recuperes dans ce demontage. Utile pour la UI: on affiche a l'operateur
 * "voici ce qu'il reste a demonter selon la composition d'origine".
 *
 * Si la borne n'est pas connue de Factory, on renvoie une liste vide.
 * L'operateur peut toujours ajouter des composants a la main via scan.
 */
export async function suggestions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const dis = await prisma.disassembly.findUnique({
      where: { id },
      include: { components: true },
    });
    if (!dis) throw new AppError('Demontage introuvable', 404);

    const assembly = await prisma.assemblyOrder.findFirst({
      where: { internalNumber: dis.borneInternalNumber, status: 'COMPLETED' },
      include: {
        components: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!assembly) {
      res.json({ success: true, data: { items: [] } });
      return;
    }

    // Une piece est deja recuperee si on retrouve son productId+SN (ou
    // productId+quantite pour les non-serialises) dans les components
    // du demontage.
    const recoveredKeys = new Set<string>();
    for (const c of dis.components) {
      recoveredKeys.add(`${c.productId}::${c.serialNumber || ''}`);
    }

    const items = assembly.components.map((c) => {
      const key = `${c.productId}::${c.serialNumber || ''}`;
      const alreadyRecovered = recoveredKeys.has(key);
      return {
        productId: c.productId,
        productReference: c.productReference,
        serialNumber: c.serialNumber,
        quantity: c.quantity,
        alreadyRecovered,
      };
    });

    res.json({ success: true, data: { items } });
  } catch (err) {
    next(err);
  }
}

// ---------- TRANSITIONS ----------

export async function transition(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const body = transitionSchema.parse(req.body);
    const existing = await prisma.disassembly.findUnique({
      where: { id },
      include: { components: true },
    });
    if (!existing) throw new AppError('Demontage introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Demontage deja clos', 400);
    }

    const validTransitions: Record<string, string[]> = {
      DRAFT: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
    };
    if (!validTransitions[existing.status]?.includes(body.to)) {
      throw new AppError(`Transition ${existing.status} → ${body.to} interdite`, 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const data: any = { status: body.to };
      if (body.to === 'IN_PROGRESS' && !existing.startedAt) {
        data.startedAt = new Date();
        data.operatorId = req.user.id;
        data.operatorName = req.user.fullName || req.user.username;
      }
      if (body.to === 'COMPLETED') {
        data.completedAt = new Date();
      }
      const u = await tx.disassembly.update({
        where: { id },
        data,
        include: { components: true },
      });
      await logDisassemblyEvent(tx as any, id, 'STATUS_CHANGED', req.user, {
        from: existing.status,
        to: body.to,
      });
      if (body.to === 'IN_PROGRESS' && !existing.startedAt) {
        await logDisassemblyEvent(tx as any, id, 'STARTED', req.user);
      }
      if (body.to === 'COMPLETED') {
        await logDisassemblyEvent(tx as any, id, 'COMPLETED', req.user, {
          componentsCount: u.components.length,
        });
      }
      if (body.to === 'CANCELLED') {
        await logDisassemblyEvent(tx as any, id, 'CANCELLED', req.user, {
          reason: body.reason || null,
        });
      }
      return u;
    });

    // Publish sur RabbitMQ. A la validation, Bornes archive la borne.
    if (body.to === 'COMPLETED') {
      void publishEvent(
        'disassemblies',
        'completed',
        {
          id: updated.id,
          borneInternalNumber: updated.borneInternalNumber,
          sourceApp: updated.sourceApp,
          reason: updated.reason,
          completedAt: updated.completedAt,
          operator: updated.operatorName,
          components: updated.components.map((c) => ({
            productId: c.productId,
            productReference: c.productReference,
            serialNumber: c.serialNumber,
            quantity: c.quantity,
            disposition: c.disposition,
          })),
        },
        req.user,
      );
    }
    if (body.to === 'CANCELLED') {
      void publishEvent(
        'disassemblies',
        'cancelled',
        {
          id: updated.id,
          borneInternalNumber: updated.borneInternalNumber,
          reason: body.reason || null,
        },
        req.user,
      );
    }

    res.json({ success: true, data: { order: updated } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}
