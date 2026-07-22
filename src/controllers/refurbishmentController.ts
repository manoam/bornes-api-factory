import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';
import { logRefurbishmentEvent } from '../services/refurbishmentEventLog';
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
 * Reconditionnements Factory V1.
 *
 * Combo Reparation + Demontage :
 * - une seule phase IN_PROGRESS ou on retire (REMOVED) et installe (INSTALLED)
 *   des composants comme dans une reparation
 * - phase TESTING avec les 6 controles qualite standard
 * - a la validation, publie factory.refurbishments.completed → Bornes remet
 *   la borne en statut "prete a louer" (au lieu d'archiver comme le
 *   demontage)
 * - le borneInternalNumber ne change pas (voir Q1 = A dans le cadrage) : on
 *   veut suivre toute la vie d'une borne physique.
 */

const createSchema = z.object({
  borneInternalNumber: z.string().min(1, 'Numero de borne requis'),
  reason: z.string().optional().nullable(),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).optional(),
});

const updateSchema = z.object({
  reason: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  qualityChecks: z.array(z.string()).optional(),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).optional(),
});

const addComponentSchema = z.object({
  action: z.enum(['REMOVED', 'INSTALLED']),
  productId: z.string().min(1),
  productReference: z.string().min(1),
  productDescription: z.string().optional().nullable(),
  serialNumber: z.string().optional().nullable(),
  quantity: z.number().int().positive().default(1),
  disposition: z.enum(['STOCK_NEW', 'STOCK_USED', 'TO_TEST', 'SCRAP']).optional(),
});

/**
 * Body du "remplacement par categorie". Les 2 blocs sont OPTIONNELS :
 * - `removed` seul  = on retire l'ancien sans installer de nouveau
 * - `installed` seul = on installe sans retirer d'ancien (ex : ajout net)
 * - les 2         = remplacement (l'ancien va en STOCK_USED/SCRAP, le nouveau installe)
 * Si les 2 sont absents -> delete des lignes existantes pour cette categorie.
 */
const upsertCategoryReplacementSchema = z.object({
  removed: z
    .object({
      productId: z.string().min(1),
      productReference: z.string().min(1),
      productDescription: z.string().optional().nullable(),
      serialNumber: z.string().optional().nullable(),
      quantity: z.number().int().positive().default(1),
      disposition: z.enum(['STOCK_NEW', 'STOCK_USED', 'TO_TEST', 'SCRAP']).default('STOCK_USED'),
    })
    .optional()
    .nullable(),
  installed: z
    .object({
      productId: z.string().min(1),
      productReference: z.string().min(1),
      productDescription: z.string().optional().nullable(),
      serialNumber: z.string().optional().nullable(),
      quantity: z.number().int().positive().default(1),
    })
    .optional()
    .nullable(),
});

const transitionSchema = z.object({
  to: z.enum(['IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED']),
  reason: z.string().optional(),
});

const STATUS_VALUES = ['DRAFT', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED'] as const;

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
      prisma.refurbishment.findMany({
        where: listWhere,
        include: { _count: { select: { components: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.refurbishment.count({ where: listWhere }),
      prisma.refurbishment.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const stats: Record<string, number> = {
      DRAFT: 0,
      IN_PROGRESS: 0,
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
    const refurb = await prisma.refurbishment.findUnique({
      where: { id },
      include: { components: { orderBy: { createdAt: 'asc' } } },
    });
    if (!refurb) throw new AppError('Reconditionnement introuvable', 404);
    res.json({ success: true, data: refurb });
  } catch (err) {
    next(err);
  }
}

// ---------- CREATE ----------

export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const body = createSchema.parse(req.body);
    const internal = body.borneInternalNumber.trim();

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

    const refurb = await prisma.$transaction(async (tx) => {
      const created = await tx.refurbishment.create({
        data: {
          borneInternalNumber: internal,
          sourceApp,
          reason: body.reason || null,
          priority: body.priority || 'NORMAL',
          createdById: req.user.id,
          createdByName: req.user.fullName || req.user.username,
        },
      });
      await logRefurbishmentEvent(tx as any, created.id, 'STATUS_CHANGED', req.user, {
        from: null,
        to: 'DRAFT',
      });
      if (body.reason) {
        await logRefurbishmentEvent(tx as any, created.id, 'REASON_UPDATED', req.user);
      }
      return created;
    });

    res.status(201).json({ success: true, data: refurb });
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
    const existing = await prisma.refurbishment.findUnique({ where: { id } });
    if (!existing) throw new AppError('Reconditionnement introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Reconditionnement clos — modification impossible', 400);
    }

    const data: any = {};
    if (body.reason !== undefined) data.reason = body.reason;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.qualityChecks !== undefined) data.qualityChecks = body.qualityChecks;
    if (body.priority !== undefined) data.priority = body.priority;

    const refurb = await prisma.$transaction(async (tx) => {
      const updated = await tx.refurbishment.update({
        where: { id },
        data,
        include: { components: true },
      });
      if (body.reason !== undefined && body.reason !== existing.reason) {
        await logRefurbishmentEvent(tx as any, id, 'REASON_UPDATED', req.user);
      }
      if (body.priority !== undefined && body.priority !== existing.priority) {
        await logRefurbishmentEvent(tx as any, id, 'PRIORITY_UPDATED', req.user, {
          from: existing.priority,
          to: body.priority,
        });
      }
      if (body.notes !== undefined && body.notes !== existing.notes) {
        await logRefurbishmentEvent(tx as any, id, 'NOTES_UPDATED', req.user);
      }
      if (body.qualityChecks !== undefined) {
        const before = new Set<string>((existing.qualityChecks as string[] | null) || []);
        const after = new Set<string>(body.qualityChecks);
        for (const cid of after) {
          if (!before.has(cid)) {
            await logRefurbishmentEvent(tx as any, id, 'QUALITY_CHECKED', req.user, {
              checkId: cid,
            });
          }
        }
        for (const cid of before) {
          if (!after.has(cid)) {
            await logRefurbishmentEvent(tx as any, id, 'QUALITY_UNCHECKED', req.user, {
              checkId: cid,
            });
          }
        }
      }
      return updated;
    });

    res.json({ success: true, data: refurb });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}

// ---------- COMPONENTS ----------

/**
 * POST /refurbishments/:id/components
 *
 * Cree une ligne REMOVED ou INSTALLED. Les mouvements Stock suivent la
 * meme logique qu'une reparation:
 *   - INSTALLED: OUT depuis l'atelier (condition NEW)
 *   - REMOVED avec disposition: IN vers l'atelier (condition selon dispo)
 */
export async function addComponent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const body = addComponentSchema.parse(req.body);
    const existing = await prisma.refurbishment.findUnique({ where: { id } });
    if (!existing) throw new AppError('Reconditionnement introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Reconditionnement clos — modification impossible', 400);
    }
    if (existing.status === 'DRAFT') {
      throw new AppError(
        'Demarrer le reconditionnement avant d\'ajouter des composants',
        400,
      );
    }
    if (body.action === 'REMOVED' && !body.disposition) {
      throw new AppError('Disposition requise pour un composant retire', 400);
    }

    const stock = stockClientFor(req.user.rawToken);
    let stockMovementId: string | null = null;
    try {
      const atelier = await stock.getAtelierSite();
      if (body.action === 'INSTALLED') {
        const movement = await stock.createMovement({
          productId: body.productId,
          type: 'OUT',
          quantity: body.quantity,
          condition: 'NEW',
          movementDate: new Date().toISOString(),
          sourceSiteId: atelier.id,
          comment: `Reconditionnement ${existing.borneInternalNumber} — installation`,
          ...(body.serialNumber ? { serialNumbers: [body.serialNumber] } : {}),
        });
        stockMovementId = movement.id;
      } else {
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
          comment: `Reconditionnement ${existing.borneInternalNumber} — ${suffix}`,
          ...(body.serialNumber ? { serialNumbers: [body.serialNumber] } : {}),
        });
        stockMovementId = movement.id;
      }
    } catch (err) {
      console.warn(
        '[refurbishments] Stock createMovement failed, keeping local record:',
        err instanceof Error ? err.message : String(err),
      );
    }

    const component = await prisma.$transaction(async (tx) => {
      const c = await tx.refurbishmentComponent.create({
        data: {
          refurbishmentId: id,
          action: body.action,
          productId: body.productId,
          productReference: body.productReference,
          serialNumber: body.serialNumber || null,
          quantity: body.quantity,
          disposition: body.action === 'REMOVED' ? body.disposition || null : null,
          stockMovementId,
        },
      });
      await logRefurbishmentEvent(
        tx as any,
        id,
        body.action === 'REMOVED' ? 'COMPONENT_REMOVED' : 'COMPONENT_INSTALLED',
        req.user,
        {
          productRef: body.productReference,
          serialNumber: body.serialNumber || null,
          quantity: body.quantity,
          disposition: body.disposition || null,
          stockMovementId,
        },
      );
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
    const component = await prisma.refurbishmentComponent.findUnique({
      where: { id: componentId },
      include: { refurbishment: true },
    });
    if (!component || component.refurbishmentId !== id) {
      throw new AppError('Composant introuvable', 404);
    }
    if (
      component.refurbishment.status === 'COMPLETED' ||
      component.refurbishment.status === 'CANCELLED'
    ) {
      throw new AppError('Reconditionnement clos — retrait impossible', 400);
    }

    await prisma.$transaction(async (tx) => {
      await tx.refurbishmentComponent.delete({ where: { id: component.id } });
      await logRefurbishmentEvent(tx as any, id, 'COMPONENT_REVERTED', req.user, {
        productRef: component.productReference,
        serialNumber: component.serialNumber,
        action: component.action,
        stockMovementId: component.stockMovementId,
      });
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /refurbishments/:id/categories/:productCategoryId
 *
 * Mode "remplacement par categorie" : upsert atomique de 0, 1 ou 2 lignes
 * (REMOVED + INSTALLED) pour une categorie donnee.
 *
 * Body: { removed?: {...}, installed?: {...} }
 *  - removed seul     -> retrait sans installation (l'ancien s'en va)
 *  - installed seul   -> installation sans retrait (ajout net)
 *  - les 2            -> remplacement complet
 *  - aucun            -> supprime les lignes existantes pour cette categorie
 *
 * NB : ne cree PAS de mouvements Stock (contrairement a addComponent).
 * L'idee est que les mouvements sont crees a la validation COMPLETED
 * (comme pour l'assemblage). A revoir si tu veux tracer live.
 */
export async function upsertCategoryReplacement(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const productCategoryId = String(req.params.productCategoryId);
    const body = upsertCategoryReplacementSchema.parse(req.body);

    const refurb = await prisma.refurbishment.findUnique({ where: { id } });
    if (!refurb) throw new AppError('Reconditionnement introuvable', 404);
    if (refurb.status === 'COMPLETED' || refurb.status === 'CANCELLED') {
      throw new AppError('Reconditionnement clos — modification impossible', 400);
    }

    await prisma.$transaction(async (tx) => {
      // === REMOVED ===
      const existingRemoved = await tx.refurbishmentComponent.findFirst({
        where: { refurbishmentId: id, productCategoryId, action: 'REMOVED' },
      });
      if (body.removed) {
        if (existingRemoved) {
          await tx.refurbishmentComponent.update({
            where: { id: existingRemoved.id },
            data: {
              productId: body.removed.productId,
              productReference: body.removed.productReference,
              serialNumber: body.removed.serialNumber || null,
              quantity: body.removed.quantity,
              disposition: body.removed.disposition,
            },
          });
        } else {
          await tx.refurbishmentComponent.create({
            data: {
              refurbishmentId: id,
              productCategoryId,
              action: 'REMOVED',
              productId: body.removed.productId,
              productReference: body.removed.productReference,
              serialNumber: body.removed.serialNumber || null,
              quantity: body.removed.quantity,
              disposition: body.removed.disposition,
            },
          });
        }
        await logRefurbishmentEvent(tx as any, id, 'COMPONENT_REMOVED', req.user, {
          productRef: body.removed.productReference,
          productDescription: body.removed.productDescription || null,
          serialNumber: body.removed.serialNumber || null,
          quantity: body.removed.quantity,
          disposition: body.removed.disposition,
          productCategoryId,
        });
      } else if (existingRemoved) {
        await tx.refurbishmentComponent.delete({ where: { id: existingRemoved.id } });
        await logRefurbishmentEvent(tx as any, id, 'COMPONENT_REVERTED', req.user, {
          productRef: existingRemoved.productReference,
          serialNumber: existingRemoved.serialNumber,
          action: 'REMOVED',
          productCategoryId,
        });
      }

      // === INSTALLED ===
      const existingInstalled = await tx.refurbishmentComponent.findFirst({
        where: { refurbishmentId: id, productCategoryId, action: 'INSTALLED' },
      });
      if (body.installed) {
        if (existingInstalled) {
          await tx.refurbishmentComponent.update({
            where: { id: existingInstalled.id },
            data: {
              productId: body.installed.productId,
              productReference: body.installed.productReference,
              serialNumber: body.installed.serialNumber || null,
              quantity: body.installed.quantity,
            },
          });
        } else {
          await tx.refurbishmentComponent.create({
            data: {
              refurbishmentId: id,
              productCategoryId,
              action: 'INSTALLED',
              productId: body.installed.productId,
              productReference: body.installed.productReference,
              serialNumber: body.installed.serialNumber || null,
              quantity: body.installed.quantity,
            },
          });
        }
        await logRefurbishmentEvent(tx as any, id, 'COMPONENT_INSTALLED', req.user, {
          productRef: body.installed.productReference,
          productDescription: body.installed.productDescription || null,
          serialNumber: body.installed.serialNumber || null,
          quantity: body.installed.quantity,
          productCategoryId,
        });
      } else if (existingInstalled) {
        await tx.refurbishmentComponent.delete({ where: { id: existingInstalled.id } });
        await logRefurbishmentEvent(tx as any, id, 'COMPONENT_REVERTED', req.user, {
          productRef: existingInstalled.productReference,
          serialNumber: existingInstalled.serialNumber,
          action: 'INSTALLED',
          productCategoryId,
        });
      }
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}

// ---------- HISTORY ----------

export async function history(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const events = await prisma.refurbishmentEvent.findMany({
      where: { refurbishmentId: id },
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
    const refurb = await prisma.refurbishment.findUnique({
      where: { id },
      select: { borneInternalNumber: true, sourceApp: true },
    });
    if (!refurb) throw new AppError('Reconditionnement introuvable', 404);

    const result: {
      internalNumber: string;
      sourceApp: string;
      factoryAssembly:
        | {
            id: string;
            model: string;
            completedAt: Date | null;
          }
        | null;
      parcBorne: BorneRow | null;
      parcError: string | null;
    } = {
      internalNumber: refurb.borneInternalNumber,
      sourceApp: refurb.sourceApp,
      factoryAssembly: null,
      parcBorne: null,
      parcError: null,
    };

    const assembly = await prisma.assemblyOrder.findFirst({
      where: { internalNumber: refurb.borneInternalNumber, status: 'COMPLETED' },
      include: { productionOrder: { select: { model: true } } },
    });
    if (assembly) {
      result.factoryAssembly = {
        id: assembly.id,
        model: assembly.productionOrder.model,
        completedAt: assembly.completedAt,
      };
    }

    if (isBornesConfigured()) {
      try {
        const snap = await getBornesSnapshot();
        const found = snap.byInternal.get(refurb.borneInternalNumber);
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
 * GET /refurbishments/:id/suggestions
 *
 * Retourne la composition Factory d'origine, en excluant les composants
 * deja retires dans ce reconditionnement. L'UI affiche chaque ligne avec
 * un bouton "Retirer" — la revue guidee (Q4 = A version simple).
 */
export async function suggestions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const refurb = await prisma.refurbishment.findUnique({
      where: { id },
      include: { components: true },
    });
    if (!refurb) throw new AppError('Reconditionnement introuvable', 404);

    const assembly = await prisma.assemblyOrder.findFirst({
      where: { internalNumber: refurb.borneInternalNumber, status: 'COMPLETED' },
      include: { components: { orderBy: { createdAt: 'asc' } } },
    });

    if (!assembly) {
      res.json({ success: true, data: { items: [] } });
      return;
    }

    // Une piece est deja retiree si on la retrouve dans les REMOVED du
    // reconditionnement (matching productId + SN).
    const removedKeys = new Set<string>();
    for (const c of refurb.components) {
      if (c.action !== 'REMOVED') continue;
      removedKeys.add(`${c.productId}::${c.serialNumber || ''}`);
    }

    // Enrichit chaque composant d'origine avec productCategoryId +
    // productDescription (via Stock) pour le mapping cote UI. Le fetch
    // est N+1 pour l'instant — a batcher plus tard si perf devient un
    // souci (Stock devra exposer GET /products?ids=).
    const stock = stockClientFor(req.user.rawToken);
    const uniqIds = Array.from(new Set(assembly.components.map((c) => c.productId)));
    const productsById = new Map<
      string,
      { productCategoryId: string | null; description: string | null }
    >();
    await Promise.all(
      uniqIds.map(async (pid) => {
        try {
          const p = await stock.getProduct(pid);
          productsById.set(pid, {
            productCategoryId: p.productCategoryId ?? null,
            description: p.description ?? null,
          });
        } catch {
          productsById.set(pid, { productCategoryId: null, description: null });
        }
      }),
    );

    const items = assembly.components.map((c) => {
      const key = `${c.productId}::${c.serialNumber || ''}`;
      const alreadyRemoved = removedKeys.has(key);
      const meta = productsById.get(c.productId);
      return {
        productId: c.productId,
        productReference: c.productReference,
        productDescription: meta?.description ?? null,
        productCategoryId: meta?.productCategoryId ?? null,
        serialNumber: c.serialNumber,
        quantity: c.quantity,
        alreadyRemoved,
      };
    });

    res.json({ success: true, data: { items } });
  } catch (err) {
    next(err);
  }
}

// ---------- CHECKLIST (quality) ----------

export async function checklist(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const refurb = await prisma.refurbishment.findUnique({ where: { id } });
    if (!refurb) throw new AppError('Reconditionnement introuvable', 404);
    res.json({
      success: true,
      data: {
        qualityChecks: QUALITY_CHECKS,
        checked: (refurb.qualityChecks as string[] | null) || [],
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
    const existing = await prisma.refurbishment.findUnique({
      where: { id },
      include: { components: true },
    });
    if (!existing) throw new AppError('Reconditionnement introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Reconditionnement deja clos', 400);
    }

    const validTransitions: Record<string, string[]> = {
      DRAFT: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['TESTING', 'CANCELLED'],
      TESTING: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    };
    if (!validTransitions[existing.status]?.includes(body.to)) {
      throw new AppError(`Transition ${existing.status} → ${body.to} interdite`, 400);
    }

    if (body.to === 'TESTING' && existing.components.length === 0) {
      throw new AppError(
        'Aucun composant enregistre — la revue est vide, rien a tester',
        400,
      );
    }
    if (body.to === 'COMPLETED') {
      const checks = (existing.qualityChecks as string[] | null) || [];
      const missing = REQUIRED_QUALITY_CHECK_IDS.filter((cid) => !checks.includes(cid));
      if (missing.length > 0) {
        throw new AppError(`${missing.length} controle(s) qualite manquant(s)`, 400);
      }
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
      const u = await tx.refurbishment.update({
        where: { id },
        data,
        include: { components: true },
      });
      await logRefurbishmentEvent(tx as any, id, 'STATUS_CHANGED', req.user, {
        from: existing.status,
        to: body.to,
      });
      if (body.to === 'IN_PROGRESS' && !existing.startedAt) {
        await logRefurbishmentEvent(tx as any, id, 'STARTED', req.user);
      }
      if (body.to === 'COMPLETED') {
        await logRefurbishmentEvent(tx as any, id, 'COMPLETED', req.user, {
          componentsCount: u.components.length,
        });
      }
      if (body.to === 'CANCELLED') {
        await logRefurbishmentEvent(tx as any, id, 'CANCELLED', req.user, {
          reason: body.reason || null,
        });
      }
      return u;
    });

    // A la validation, on cree les mouvements Stock pour tous les composants
    // qui n'en ont pas encore (mode matrice : upsertCategoryReplacement ne
    // cree pas les mouvements live, on batch a la fin).
    //
    // Regle simple V1 :
    //   REMOVED   -> IN atelier, condition=USED (tout en occasion)
    //   INSTALLED -> OUT atelier, condition=NEW
    //
    // On IGNORE les SN dans le mouvement pour eviter les collisions
    // unique(productId, serialNumber) cote Stock. Le suivi SN precis
    // sera fait dans une iteration future via un endpoint dedie.
    if (body.to === 'COMPLETED') {
      const stock = stockClientFor(req.user.rawToken);
      let atelierId: string | null = null;
      try {
        const atelier = await stock.getAtelierSite();
        atelierId = atelier.id;
      } catch (err) {
        console.warn(
          '[refurbishments] getAtelierSite failed, skipping stock movements:',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (atelierId) {
        for (const c of updated.components) {
          if (c.stockMovementId) continue; // deja fait via addComponent
          try {
            let movement: { id: string } | null = null;
            if (c.action === 'INSTALLED') {
              // OUT depuis atelier. Si SN-trace, on doit resoudre le SN
              // string -> serialItemId. Si pas de SN saisi, on skip.
              const meta = await stock.getProduct(c.productId).catch(() => null);
              const isSerialTracked = !!meta?.hasSerialNumber;
              if (isSerialTracked) {
                if (!c.serialNumber || !c.serialNumber.trim()) {
                  console.warn(
                    `[refurbishments] SKIP INSTALLED OUT produit ${c.productId} : SN manquant sur composant ${c.id}`,
                  );
                  continue;
                }
                const serialItems = await stock.getSerialItems(c.productId, {
                  status: 'IN_STOCK',
                });
                const found = serialItems.find((s) => s.serialNumber === c.serialNumber);
                if (!found) {
                  console.warn(
                    `[refurbishments] SN "${c.serialNumber}" introuvable cote Stock pour ${c.productId}`,
                  );
                  continue;
                }
                movement = await stock.createMovement({
                  productId: c.productId,
                  type: 'OUT',
                  quantity: 1,
                  condition: 'NEW',
                  movementDate: new Date().toISOString(),
                  sourceSiteId: atelierId,
                  comment: `Reconditionnement ${updated.borneInternalNumber} — installation`,
                  serialItemIds: [found.id],
                });
              } else {
                movement = await stock.createMovement({
                  productId: c.productId,
                  type: 'OUT',
                  quantity: c.quantity,
                  condition: 'NEW',
                  movementDate: new Date().toISOString(),
                  sourceSiteId: atelierId,
                  comment: `Reconditionnement ${updated.borneInternalNumber} — installation`,
                });
              }
            } else {
              // REMOVED : retour atelier en occasion. IN accepte
              // serialNumbers (creation) — safe meme si SN existe deja
              // (Stock geree la contrainte, si collision on log).
              movement = await stock.createMovement({
                productId: c.productId,
                type: 'IN',
                quantity: c.quantity,
                condition: 'USED',
                movementDate: new Date().toISOString(),
                targetSiteId: atelierId,
                comment: `Reconditionnement ${updated.borneInternalNumber} — retour occasion`,
              });
            }
            if (movement) {
              await prisma.refurbishmentComponent.update({
                where: { id: c.id },
                data: { stockMovementId: movement.id },
              });
            }
          } catch (err) {
            console.warn(
              `[refurbishments] createMovement failed for component ${c.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    }

    // A la validation, Bornes remet la borne en statut "prete a louer".
    if (body.to === 'COMPLETED') {
      void publishEvent(
        'refurbishments',
        'completed',
        {
          id: updated.id,
          borneInternalNumber: updated.borneInternalNumber,
          sourceApp: updated.sourceApp,
          reason: updated.reason,
          completedAt: updated.completedAt,
          operator: updated.operatorName,
          components: updated.components.map((c) => ({
            action: c.action,
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
        'refurbishments',
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
