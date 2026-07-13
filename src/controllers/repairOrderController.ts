import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';
import { logRepairEvent } from '../services/repairEventLog';
import { stockClientFor } from '../services/stockClient';
import {
  getBornesSnapshot,
  isConfigured as isBornesConfigured,
  type BorneRow,
} from '../services/bornesClient';
import { enrichRowsWithBornes } from '../services/borneEnrich';
import { publishEvent } from '../services/rabbitmqHttp';
import { QUALITY_CHECKS, REQUIRED_QUALITY_CHECK_IDS } from '../config/qualityChecks';

/**
 * Ordres de reparation V1.
 *
 * Flow attendu :
 *   1. POST /repair-orders  { borneInternalNumber, diagnosis? }
 *      -> cree en DRAFT, tente de resoudre la borne (Factory ou Bornes)
 *   2. POST /:id/transition to=IN_PROGRESS  (demarre l'atelier)
 *   3. POST /:id/components { action: REMOVED|INSTALLED, ... }  (repete)
 *      -> chaque ligne genere un mvt Stock (IN pour REMOVED, OUT pour INSTALLED)
 *   4. POST /:id/transition to=TESTING
 *   5. PATCH /:id { qualityChecks: [...] }  (coche les 6 controles)
 *   6. POST /:id/transition to=COMPLETED
 *      -> publie factory.repair_orders.completed sur RabbitMQ
 */

const createSchema = z.object({
  borneInternalNumber: z.string().min(1, 'Numero de borne requis'),
  diagnosis: z.string().optional().nullable(),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).optional(),
});

const updateSchema = z.object({
  diagnosis: z.string().optional().nullable(),
  diagnosisSource: z.string().optional().nullable(),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).optional(),
  notes: z.string().optional().nullable(),
  qualityChecks: z.array(z.string()).optional(),
  report: z.string().optional().nullable(),
});

// V2 — nouvelle shape d'une ligne d'intervention.
const addComponentSchema = z.object({
  kind: z.enum(['REPLACED', 'CHECKED', 'DIAGNOSED']),
  productId: z.string().min(1),
  productReference: z.string().min(1),
  serialNumber: z.string().optional().nullable(),
  quantity: z.number().int().positive().default(1),
  partState: z.enum(['OK', 'DEFECTIVE', 'TO_CHECK', 'SUSPECT']).default('OK'),
  comment: z.string().optional().nullable(),
});

const transitionSchema = z.object({
  to: z.enum(['IN_PROGRESS', 'ON_HOLD', 'TESTING', 'COMPLETED', 'CANCELLED']),
  reason: z.string().optional(),
  onHoldReason: z.string().optional(),
});

// ---------- LIST ----------

const STATUS_VALUES = ['DRAFT', 'IN_PROGRESS', 'ON_HOLD', 'TESTING', 'COMPLETED', 'CANCELLED'] as const;

/**
 * GET /repair-orders
 * Query: status (multi), search (n interne + diagnosis), operatorId, mine, limit, offset.
 */
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
        { diagnosis: { contains: search, mode: 'insensitive' } },
      ];
    }
    const listWhere: any = { ...baseWhere };
    if (statusFilter && statusFilter.length > 0) listWhere.status = { in: statusFilter };

    const [rows, total, statsRaw] = await Promise.all([
      prisma.repairOrder.findMany({
        where: listWhere,
        include: {
          _count: { select: { components: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.repairOrder.count({ where: listWhere }),
      prisma.repairOrder.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const stats: Record<string, number> = {
      DRAFT: 0,
      IN_PROGRESS: 0,
      ON_HOLD: 0,
      TESTING: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    for (const s of statsRaw) stats[s.status] = s._count._all;

    const shaped = rows.map((r) => ({
      id: r.id,
      borneInternalNumber: r.borneInternalNumber,
      sourceApp: r.sourceApp,
      status: r.status,
      priority: r.priority,
      diagnosis: r.diagnosis,
      operatorName: r.operatorName,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      createdByName: r.createdByName,
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
    const order = await prisma.repairOrder.findUnique({
      where: { id },
      include: {
        components: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) throw new AppError('Ordre de reparation introuvable', 404);
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
}

// ---------- CREATE ----------

/**
 * Cree un RepairOrder et tente de resoudre la borne :
 *   1. Cherche en local dans les AssemblyOrder termines
 *   2. Sinon interroge l'API Bornes du collegue via bornesClient
 *   3. Sinon sourceApp = 'unknown' — la borne existe peut-etre mais on ne
 *      peut pas confirmer. On laisse l'operateur avancer quand meme.
 */
export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const body = createSchema.parse(req.body);
    const internal = body.borneInternalNumber.trim();

    let sourceApp = 'unknown';

    // 1. Factory
    const localAssembly = await prisma.assemblyOrder.findFirst({
      where: { internalNumber: internal, status: 'COMPLETED' },
      select: { id: true },
    });
    if (localAssembly) sourceApp = 'factory';

    // 2. Bornes API
    if (sourceApp === 'unknown' && isBornesConfigured()) {
      try {
        const snap = await getBornesSnapshot();
        if (snap.byInternal.has(internal)) sourceApp = 'bornes';
      } catch {
        // ignore, sourceApp reste unknown
      }
    }

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.repairOrder.create({
        data: {
          borneInternalNumber: internal,
          sourceApp,
          diagnosis: body.diagnosis || null,
          // V2 — source par defaut deduite de sourceApp (visible dans le
          // bandeau "Probleme signale").
          diagnosisSource: sourceApp === 'bornes' ? 'Remonte du parc' : 'Cree manuellement',
          priority: body.priority || 'NORMAL',
          createdById: req.user.id,
          createdByName: req.user.fullName || req.user.username,
        },
      });
      await logRepairEvent(tx as any, created.id, 'STATUS_CHANGED', req.user, {
        from: null,
        to: 'DRAFT',
      });
      if (body.diagnosis) {
        await logRepairEvent(tx as any, created.id, 'DIAGNOSIS_UPDATED', req.user);
      }
      return created;
    });

    res.status(201).json({ success: true, data: order });
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
    const existing = await prisma.repairOrder.findUnique({ where: { id } });
    if (!existing) throw new AppError('Ordre de reparation introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Ordre clos — modification impossible', 400);
    }

    const data: any = {};
    if (body.diagnosis !== undefined) data.diagnosis = body.diagnosis;
    if (body.diagnosisSource !== undefined) data.diagnosisSource = body.diagnosisSource;
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.qualityChecks !== undefined) data.qualityChecks = body.qualityChecks;
    if (body.report !== undefined) data.report = body.report;

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.repairOrder.update({
        where: { id },
        data,
        include: { components: true },
      });
      if (body.notes !== undefined && body.notes !== existing.notes) {
        await logRepairEvent(tx as any, id, 'NOTES_UPDATED', req.user);
      }
      if (body.diagnosis !== undefined && body.diagnosis !== existing.diagnosis) {
        await logRepairEvent(tx as any, id, 'DIAGNOSIS_UPDATED', req.user);
      }
      if (body.diagnosisSource !== undefined && body.diagnosisSource !== existing.diagnosisSource) {
        await logRepairEvent(tx as any, id, 'DIAGNOSIS_SOURCE_UPDATED', req.user);
      }
      if (body.priority !== undefined && body.priority !== existing.priority) {
        await logRepairEvent(tx as any, id, 'PRIORITY_UPDATED', req.user, {
          from: existing.priority,
          to: body.priority,
        });
      }
      if (body.report !== undefined && body.report !== existing.report) {
        await logRepairEvent(tx as any, id, 'REPORT_UPDATED', req.user);
      }
      if (body.qualityChecks !== undefined) {
        const before = new Set<string>((existing.qualityChecks as string[] | null) || []);
        const after = new Set<string>(body.qualityChecks);
        for (const cid of after) {
          if (!before.has(cid)) {
            await logRepairEvent(tx as any, id, 'QUALITY_CHECKED', req.user, { checkId: cid });
          }
        }
        for (const cid of before) {
          if (!after.has(cid)) {
            await logRepairEvent(tx as any, id, 'QUALITY_UNCHECKED', req.user, { checkId: cid });
          }
        }
      }
      return updated;
    });

    res.json({ success: true, data: order });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}

// ---------- COMPONENTS ----------

/**
 * POST /repair-orders/:id/components
 *
 * Cree une ligne REMOVED ou INSTALLED. Pour REMOVED, on demande a Stock
 * de creer un mouvement IN vers un site "SAV" (a defaut Atelier), avec
 * une condition qui depend de la disposition:
 *   - TO_TEST     -> IN condition USED, comment "SAV a tester"
 *   - SCRAP       -> IN condition USED, comment "SAV rebut"
 *   - STOCK_USED  -> IN condition USED, comment "SAV OK reinjecte"
 *
 * Pour INSTALLED, on cree un OUT depuis le site Atelier avec la meme
 * condition qu'un assemblage neuf.
 *
 * Si Stock n'est pas dispo, on cree quand meme la ligne cote Factory
 * (avec stockMovementId=null) et on log un warning. L'operateur peut
 * refaire tourner la sync plus tard.
 */
/**
 * V2 — POST /repair-orders/:id/components
 *
 * Ajoute une ligne de declaration d'intervention. Selon `kind`:
 *   - REPLACED  : cree 2 mouvements Stock (OUT piece neuve depuis atelier
 *                 + IN piece retiree vers atelier). La condition IN
 *                 depend de partState :
 *                    OK        => USED
 *                    DEFECTIVE => USED (mais commentaire "rebut")
 *                    TO_CHECK  => USED (commentaire "a tester")
 *                    SUSPECT   => USED (commentaire "suspect")
 *   - CHECKED   : aucun mouvement Stock (piece resta sur la borne).
 *   - DIAGNOSED : aucun mouvement Stock (decision differee).
 *
 * Si Stock est injoignable, on cree la ligne quand meme avec
 * stockMovementIds vide et un warning au log.
 */
export async function addComponent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const body = addComponentSchema.parse(req.body);
    const existing = await prisma.repairOrder.findUnique({ where: { id } });
    if (!existing) throw new AppError('Ordre de reparation introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Ordre clos — modification impossible', 400);
    }
    if (existing.status === 'DRAFT') {
      throw new AppError('Demarrer la reparation avant d\'ajouter des composants', 400);
    }

    const stockMovementIds: string[] = [];
    if (body.kind === 'REPLACED') {
      const stock = stockClientFor(req.user.rawToken);
      try {
        const atelier = await stock.getAtelierSite();
        const partSuffix =
          body.partState === 'DEFECTIVE'
            ? 'piece HS rebut'
            : body.partState === 'TO_CHECK'
              ? 'piece a tester'
              : body.partState === 'SUSPECT'
                ? 'piece suspecte'
                : 'piece OK reinjection';
        // OUT : nouvelle piece depuis atelier
        const out = await stock.createMovement({
          productId: body.productId,
          type: 'OUT',
          quantity: body.quantity,
          condition: 'NEW',
          movementDate: new Date().toISOString(),
          sourceSiteId: atelier.id,
          comment: `Reparation ${existing.borneInternalNumber} — installation neuve`,
          ...(body.serialNumber ? { serialNumbers: [body.serialNumber] } : {}),
        });
        stockMovementIds.push(out.id);
        // IN : ancienne piece retiree vers atelier
        const inMv = await stock.createMovement({
          productId: body.productId,
          type: 'IN',
          quantity: body.quantity,
          condition: 'USED',
          movementDate: new Date().toISOString(),
          targetSiteId: atelier.id,
          comment: `Reparation ${existing.borneInternalNumber} — ${partSuffix}`,
        });
        stockMovementIds.push(inMv.id);
      } catch (err) {
        console.warn(
          '[repair-orders] Stock createMovement failed for REPLACED, keeping local record:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const component = await prisma.$transaction(async (tx) => {
      const c = await tx.repairComponent.create({
        data: {
          repairOrderId: id,
          kind: body.kind,
          productId: body.productId,
          productReference: body.productReference,
          serialNumber: body.serialNumber || null,
          quantity: body.quantity,
          partState: body.partState,
          comment: body.comment || null,
          stockMovementIds: stockMovementIds.length > 0 ? stockMovementIds : undefined,
        },
      });
      await logRepairEvent(tx as any, id, 'COMPONENT_ADDED', req.user, {
        kind: body.kind,
        productRef: body.productReference,
        serialNumber: body.serialNumber || null,
        quantity: body.quantity,
        partState: body.partState,
        comment: body.comment || null,
        stockMovementIds,
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
    const component = await prisma.repairComponent.findUnique({
      where: { id: componentId },
      include: { repairOrder: true },
    });
    if (!component || component.repairOrderId !== id) {
      throw new AppError('Composant introuvable', 404);
    }
    if (
      component.repairOrder.status === 'COMPLETED' ||
      component.repairOrder.status === 'CANCELLED'
    ) {
      throw new AppError('Ordre clos — retrait impossible', 400);
    }

    // On ne re-inverse PAS le mouvement Stock automatiquement — trop risque
    // (si le stock a bouge entre temps on cree une divergence). L'operateur
    // devra faire un mvt inverse manuel s'il le souhaite. On log juste.
    await prisma.$transaction(async (tx) => {
      await tx.repairComponent.delete({ where: { id: component.id } });
      await logRepairEvent(tx as any, id, 'COMPONENT_REVERTED', req.user, {
        productRef: component.productReference,
        serialNumber: component.serialNumber,
        kind: component.kind,
        partState: component.partState,
        stockMovementIds: (component.stockMovementIds as string[] | null) || [],
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
    const events = await prisma.repairOrderEvent.findMany({
      where: { repairOrderId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
}

// ---------- BORNE INFO (resolve helper) ----------

/**
 * GET /repair-orders/:id/borne-info
 *
 * Renvoie ce qu'on sait de la borne concernee :
 *   - si sourceApp = factory : la composition d'origine (AssemblyOrder + components)
 *   - si sourceApp = bornes  : la row API Bornes (parc, client, etat)
 *   - sinon : sourceApp = unknown
 *
 * Le frontend affiche ce qui est dispo. Robuste aux erreurs (l'API Bornes
 * peut etre down sans casser la page).
 */
export async function borneInfo(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const order = await prisma.repairOrder.findUnique({
      where: { id },
      select: { borneInternalNumber: true, sourceApp: true },
    });
    if (!order) throw new AppError('Ordre de reparation introuvable', 404);

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
      internalNumber: order.borneInternalNumber,
      sourceApp: order.sourceApp,
      factoryAssembly: null,
      parcBorne: null,
      parcError: null,
    };

    // Factory side
    const assembly = await prisma.assemblyOrder.findFirst({
      where: {
        internalNumber: order.borneInternalNumber,
        status: 'COMPLETED',
      },
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
          productReference: c.productReference,
          serialNumber: c.serialNumber,
          quantity: c.quantity,
          installedAt: c.installedAt,
        })),
      };
    }

    // Bornes side
    if (isBornesConfigured()) {
      try {
        const snap = await getBornesSnapshot();
        const found = snap.byInternal.get(order.borneInternalNumber);
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

// ---------- CHECKLIST (quality) ----------

export async function checklist(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const order = await prisma.repairOrder.findUnique({ where: { id } });
    if (!order) throw new AppError('Ordre de reparation introuvable', 404);
    res.json({
      success: true,
      data: {
        qualityChecks: QUALITY_CHECKS,
        checked: (order.qualityChecks as string[] | null) || [],
      },
    });
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
    const existing = await prisma.repairOrder.findUnique({
      where: { id },
      include: { components: true },
    });
    if (!existing) throw new AppError('Ordre de reparation introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Ordre deja clos', 400);
    }

    const validTransitions: Record<string, string[]> = {
      DRAFT: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['ON_HOLD', 'TESTING', 'CANCELLED'],
      ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
      TESTING: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    };
    if (!validTransitions[existing.status]?.includes(body.to)) {
      throw new AppError(`Transition ${existing.status} → ${body.to} interdite`, 400);
    }

    // Guards
    if (body.to === 'ON_HOLD' && !body.onHoldReason?.trim()) {
      throw new AppError('Motif de mise en attente requis', 400);
    }
    if (body.to === 'TESTING' && existing.components.length === 0) {
      throw new AppError('Aucun composant enregistre — la reparation est vide', 400);
    }
    if (body.to === 'COMPLETED') {
      const checks = (existing.qualityChecks as string[] | null) || [];
      const missing = REQUIRED_QUALITY_CHECK_IDS.filter((cid) => !checks.includes(cid));
      if (missing.length > 0) {
        throw new AppError(`${missing.length} controle(s) qualite manquant(s)`, 400);
      }
    }

    // Apply
    const updated = await prisma.$transaction(async (tx) => {
      const data: any = { status: body.to };
      if (body.to === 'IN_PROGRESS' && !existing.startedAt) {
        data.startedAt = new Date();
        data.operatorId = req.user.id;
        data.operatorName = req.user.fullName || req.user.username;
      }
      if (body.to === 'ON_HOLD') {
        data.onHoldReason = body.onHoldReason?.trim() || null;
      }
      if (body.to === 'IN_PROGRESS' && existing.status === 'ON_HOLD') {
        // Reprise depuis pause : on nettoie le motif.
        data.onHoldReason = null;
      }
      if (body.to === 'COMPLETED') {
        data.completedAt = new Date();
      }
      const u = await tx.repairOrder.update({
        where: { id },
        data,
        include: { components: true },
      });
      await logRepairEvent(tx as any, id, 'STATUS_CHANGED', req.user, {
        from: existing.status,
        to: body.to,
      });
      if (body.to === 'IN_PROGRESS' && !existing.startedAt) {
        await logRepairEvent(tx as any, id, 'STARTED', req.user);
      }
      if (body.to === 'ON_HOLD') {
        await logRepairEvent(tx as any, id, 'ON_HOLD', req.user, {
          reason: body.onHoldReason || null,
        });
      }
      if (body.to === 'IN_PROGRESS' && existing.status === 'ON_HOLD') {
        await logRepairEvent(tx as any, id, 'RESUMED', req.user);
      }
      if (body.to === 'COMPLETED') {
        await logRepairEvent(tx as any, id, 'COMPLETED', req.user, {
          componentsCount: u.components.length,
          finalResult: u.finalResult,
        });
      }
      if (body.to === 'CANCELLED') {
        await logRepairEvent(tx as any, id, 'CANCELLED', req.user, {
          reason: body.reason || null,
        });
      }
      return u;
    });

    // V2 — Publish sur RabbitMQ pour on_hold, completed, cancelled.
    if (body.to === 'ON_HOLD') {
      void publishEvent(
        'repair_orders',
        'on_hold',
        {
          id: updated.id,
          borneInternalNumber: updated.borneInternalNumber,
          reason: body.onHoldReason || null,
        },
        req.user,
      );
    }
    if (body.to === 'COMPLETED') {
      void publishEvent(
        'repair_orders',
        'completed',
        {
          id: updated.id,
          borneInternalNumber: updated.borneInternalNumber,
          sourceApp: updated.sourceApp,
          completedAt: updated.completedAt,
          operator: updated.operatorName,
          finalResult: updated.finalResult,
          report: updated.report,
          components: updated.components.map((c) => ({
            kind: c.kind,
            productId: c.productId,
            productReference: c.productReference,
            serialNumber: c.serialNumber,
            quantity: c.quantity,
            partState: c.partState,
            comment: c.comment,
          })),
        },
        req.user,
      );
    }
    if (body.to === 'CANCELLED') {
      void publishEvent(
        'repair_orders',
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
