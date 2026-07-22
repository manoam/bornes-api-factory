import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';
import { logAssemblyEvent } from '../services/assemblyEventLog';
import { stockClientFor } from '../services/stockClient';
import { publishEvent } from '../services/rabbitmqHttp';
import { QUALITY_CHECKS, REQUIRED_QUALITY_CHECK_IDS } from '../config/qualityChecks';

const updateSchema = z.object({
  status: z.enum(['DRAFT', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED']).optional(),
  internalNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  qualityChecks: z.array(z.string()).optional(),
});

const addComponentSchema = z.object({
  productId: z.string().min(1),
  productReference: z.string().min(1),
  /** Description lisible du produit — non stockee en base, sert uniquement
   *  a enrichir le payload de l'event historique. */
  productDescription: z.string().optional().nullable(),
  serialNumber: z.string().optional().nullable(),
  quantity: z.number().int().positive().default(1),
});

const upsertCategoryComponentSchema = z.object({
  productId: z.string().min(1),
  productReference: z.string().min(1),
  productDescription: z.string().optional().nullable(),
  serialNumber: z.string().optional().nullable(),
  quantity: z.number().int().positive().default(1),
});

const transitionSchema = z.object({
  to: z.enum(['IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED']),
  internalNumber: z.string().optional(),
  reason: z.string().optional(),
});

// ---------- BATCH CREATE (raccourci UI "Bornes a creer") ----------

const batchCreateSchema = z.object({
  model: z.string().min(1, 'Modele requis'),
  quantity: z.number().int().positive('Quantite doit etre > 0').max(100, 'Max 100 par commande'),
  reason: z.string().optional().nullable(),
  targetDate: z.string().datetime().optional().nullable(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
});

/**
 * POST /assembly-orders/batch
 *
 * Raccourci UI qui remplace le flow historique en 2 etapes
 * (POST /production-orders puis POST /:id/plan). L'operateur choisit une
 * gamme + une quantite et Factory cree en une seule transaction :
 *   1. un ProductionOrder (statut PLANNED direct, pas de DRAFT intermediaire)
 *   2. N AssemblyOrder rattaches, tous en statut DRAFT
 *
 * Le ProductionOrder reste en DB pour grouper les assemblages et porter
 * le motif/target date, mais il n'est plus expose dans la sidebar. Chaque
 * AssemblyOrder apparait dans "Bornes a creer".
 */
export async function batchCreate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const body = batchCreateSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      const production = await tx.productionOrder.create({
        data: {
          model: body.model,
          quantity: body.quantity,
          priority: body.priority || 'NORMAL',
          reason: body.reason || null,
          targetDate: body.targetDate ? new Date(body.targetDate) : null,
          status: 'PLANNED',
          createdById: req.user.id,
          createdByName: req.user.fullName || req.user.username,
        },
      });

      await tx.assemblyOrder.createMany({
        data: Array.from({ length: body.quantity }, () => ({
          productionOrderId: production.id,
        })),
      });

      return tx.productionOrder.findUnique({
        where: { id: production.id },
        include: {
          assemblyOrders: {
            select: {
              id: true,
              status: true,
              internalNumber: true,
              createdAt: true,
            },
          },
        },
      });
    });

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Donnees invalides', 400));
    }
    next(err);
  }
}

// ---------- LIST ----------

const STATUS_VALUES = ['DRAFT', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED'] as const;
type StatusValue = typeof STATUS_VALUES[number];

function parseStatusFilter(raw: string | undefined): StatusValue[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is StatusValue => (STATUS_VALUES as readonly string[]).includes(s));
  return parts.length > 0 ? parts : undefined;
}

/**
 * GET /assembly-orders
 *
 * Liste paginée + filtres + stats globales par statut.
 * Query params supportés:
 *   - status=DRAFT,IN_PROGRESS   (multi-statut sépare par virgule)
 *   - model=Borne Kalifun         (exact match sur productionOrder.model)
 *   - operatorId=<keycloak-sub>
 *   - mine=true                   (raccourci: filtre sur req.user.id)
 *   - search=K001                 (substring sur internalNumber + model)
 *   - limit / offset              (défaut 50 / 0, limit cap à 200)
 *
 * Réponse contient aussi `stats` (count par statut, sans le filtre `status`
 * appliqué) pour alimenter les KPIs en haut de la page. Les autres filtres
 * SONT appliqués aux stats — sinon on afficherait des compteurs incoherents.
 */
export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const statusFilter = parseStatusFilter(req.query.status as string | undefined);
    const model = (req.query.model as string | undefined)?.trim() || undefined;
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

    // Filtres "base" (tout sauf status) — utilisés pour les stats et pour la
    // requête list (où on rajoute status par-dessus).
    const baseWhere: any = {};
    if (model) baseWhere.productionOrder = { model };
    if (operatorId) baseWhere.operatorId = operatorId;
    if (search) {
      baseWhere.OR = [
        { internalNumber: { contains: search, mode: 'insensitive' } },
        { productionOrder: { model: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const listWhere: any = { ...baseWhere };
    if (statusFilter) listWhere.status = { in: statusFilter };

    const [rows, total, statsRaw] = await Promise.all([
      prisma.assemblyOrder.findMany({
        where: listWhere,
        include: {
          productionOrder: { select: { id: true, model: true, quantity: true } },
          _count: { select: { components: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.assemblyOrder.count({ where: listWhere }),
      prisma.assemblyOrder.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const stats: Record<StatusValue, number> = {
      DRAFT: 0,
      IN_PROGRESS: 0,
      TESTING: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    for (const s of statsRaw) {
      stats[s.status as StatusValue] = s._count._all;
    }

    // Enrichir avec componentsRequired (qté items dans la BOM). On batch un
    // seul appel à Stock pour récupérer tous les assembly types et on les
    // indexe par nom — sinon c'est N+1 (un fetch par assemblage).
    const models = Array.from(new Set(rows.map((r) => r.productionOrder.model)));
    const requiredByModel = new Map<string, number>();
    if (models.length > 0) {
      try {
        const stock = stockClientFor(req.user.rawToken);
        const allTypes = await stock.getAssemblyTypes();
        for (const t of allTypes) {
          if (models.includes(t.name)) {
            requiredByModel.set(t.name, t.items?.length ?? 0);
          }
        }
      } catch {
        // Stock down: pas grave, on renvoie requiredCount=null pour ces lignes.
      }
    }

    const data = rows.map((r) => ({
      id: r.id,
      internalNumber: r.internalNumber,
      status: r.status,
      operatorId: r.operatorId,
      operatorName: r.operatorName,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      productionOrder: r.productionOrder,
      componentsInstalled: r._count.components,
      componentsRequired: requiredByModel.get(r.productionOrder.model) ?? null,
    }));

    res.json({
      success: true,
      data,
      stats,
      pagination: { total, limit, offset },
    });
  } catch (err) {
    next(err);
  }
}

// ---------- GET / PATCH basics ----------

export async function get(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const order = await prisma.assemblyOrder.findUnique({
      where: { id },
      include: {
        productionOrder: { select: { id: true, model: true, quantity: true } },
        components: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) throw new AppError("Ordre d'assemblage introuvable", 404);
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const body = updateSchema.parse(req.body);
    const existing = await prisma.assemblyOrder.findUnique({ where: { id } });
    if (!existing) throw new AppError("Ordre d'assemblage introuvable", 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError("Ordre clos — modification impossible", 400);
    }

    const data: any = {};
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.internalNumber !== undefined) data.internalNumber = body.internalNumber;
    if (body.qualityChecks !== undefined) data.qualityChecks = body.qualityChecks;
    // Status changes go through /transition only — silently ignore here.

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.assemblyOrder.update({
        where: { id },
        data,
        include: { components: true },
      });
      if (body.notes !== undefined && body.notes !== existing.notes) {
        await logAssemblyEvent(tx as any, id, 'NOTES_UPDATED', req.user);
      }
      if (body.internalNumber !== undefined && body.internalNumber !== existing.internalNumber) {
        await logAssemblyEvent(tx as any, id, 'INTERNAL_NUMBER_SET', req.user, {
          value: body.internalNumber,
        });
      }
      if (body.qualityChecks !== undefined) {
        const before = new Set<string>((existing.qualityChecks as string[] | null) || []);
        const after = new Set<string>(body.qualityChecks);
        for (const id of after) {
          if (!before.has(id)) {
            await logAssemblyEvent(tx as any, updated.id, 'QUALITY_CHECKED', req.user, { checkId: id });
          }
        }
        for (const id of before) {
          if (!after.has(id)) {
            await logAssemblyEvent(tx as any, updated.id, 'QUALITY_UNCHECKED', req.user, { checkId: id });
          }
        }
      }
      return updated;
    });

    res.json({ success: true, data: order });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
    }
    next(err);
  }
}

// ---------- Components ----------

export async function addComponent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const body = addComponentSchema.parse(req.body);
    const existing = await prisma.assemblyOrder.findUnique({ where: { id } });
    if (!existing) throw new AppError("Ordre d'assemblage introuvable", 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError("Ordre clos — installation impossible", 400);
    }

    const component = await prisma.$transaction(async (tx) => {
      const c = await tx.assemblyComponent.create({
        data: {
          assemblyOrderId: existing.id,
          productId: body.productId,
          productReference: body.productReference,
          serialNumber: body.serialNumber || null,
          quantity: body.quantity,
          status: 'INSTALLED',
          installedAt: new Date(),
        },
      });
      await logAssemblyEvent(tx as any, existing.id, 'COMPONENT_INSTALLED', req.user, {
        productRef: body.productReference,
        productDescription: body.productDescription || null,
        serialNumber: body.serialNumber || null,
        quantity: body.quantity,
      });
      return c;
    });

    res.status(201).json({ success: true, data: component });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
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
    const component = await prisma.assemblyComponent.findUnique({
      where: { id: componentId },
      include: { assemblyOrder: true },
    });
    if (!component || component.assemblyOrderId !== id) {
      throw new AppError('Composant introuvable', 404);
    }
    if (
      component.assemblyOrder.status === 'COMPLETED' ||
      component.assemblyOrder.status === 'CANCELLED'
    ) {
      throw new AppError('Ordre clos — retrait impossible', 400);
    }

    // Recup la derniere description connue via les events precedents.
    const lastKnown = await prisma.assemblyOrderEvent.findFirst({
      where: {
        assemblyOrderId: id,
        eventType: { in: ['COMPONENT_INSTALLED', 'COMPONENT_UPDATED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const lastDesc = (lastKnown?.payload as any)?.productDescription ?? null;

    await prisma.$transaction(async (tx) => {
      await tx.assemblyComponent.delete({ where: { id: component.id } });
      await logAssemblyEvent(tx as any, id, 'COMPONENT_REMOVED', req.user, {
        productRef: component.productReference,
        productDescription: lastDesc,
        serialNumber: component.serialNumber,
        quantity: component.quantity,
      });
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /assembly-orders/:id/categories/:productCategoryId
 *
 * Upsert d'UNE ligne composant par catégorie : si une ligne existe déjà
 * pour cette catégorie sur cet assemblage, elle est remplacée (produit,
 * SN, quantité). Sinon création.
 *
 * Utilisé par le panel "matrice de catégories" côté client :
 * l'opérateur voit toutes les catégories du partType du tab actif et
 * choisit AU PLUS un produit par catégorie.
 */
export async function upsertCategoryComponent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const productCategoryId = String(req.params.productCategoryId);
    const body = upsertCategoryComponentSchema.parse(req.body);

    const order = await prisma.assemblyOrder.findUnique({ where: { id } });
    if (!order) throw new AppError("Ordre d'assemblage introuvable", 404);
    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      throw new AppError('Ordre clos — modification impossible', 400);
    }

    const component = await prisma.$transaction(async (tx) => {
      const existing = await tx.assemblyComponent.findUnique({
        where: {
          assemblyOrderId_productCategoryId: {
            assemblyOrderId: id,
            productCategoryId,
          },
        },
      });

      if (existing) {
        const updated = await tx.assemblyComponent.update({
          where: { id: existing.id },
          data: {
            productId: body.productId,
            productReference: body.productReference,
            serialNumber: body.serialNumber || null,
            quantity: body.quantity,
            status: 'INSTALLED',
            installedAt: existing.installedAt ?? new Date(),
          },
        });
        await logAssemblyEvent(tx as any, id, 'COMPONENT_UPDATED', req.user, {
          productRef: body.productReference,
          productDescription: body.productDescription || null,
          serialNumber: body.serialNumber || null,
          quantity: body.quantity,
          productCategoryId,
        });
        return updated;
      }

      const created = await tx.assemblyComponent.create({
        data: {
          assemblyOrderId: id,
          productCategoryId,
          productId: body.productId,
          productReference: body.productReference,
          serialNumber: body.serialNumber || null,
          quantity: body.quantity,
          status: 'INSTALLED',
          installedAt: new Date(),
        },
      });
      await logAssemblyEvent(tx as any, id, 'COMPONENT_INSTALLED', req.user, {
        productRef: body.productReference,
        productDescription: body.productDescription || null,
        serialNumber: body.serialNumber || null,
        quantity: body.quantity,
        productCategoryId,
      });
      return created;
    });

    res.json({ success: true, data: component });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
    }
    next(err);
  }
}

/**
 * DELETE /assembly-orders/:id/categories/:productCategoryId
 *
 * Retire le composant pour cette catégorie. Utilisé quand l'opérateur
 * repasse la dropdown Produit à "aucun choix" côté UI.
 */
export async function removeCategoryComponent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const productCategoryId = String(req.params.productCategoryId);

    const order = await prisma.assemblyOrder.findUnique({ where: { id } });
    if (!order) throw new AppError("Ordre d'assemblage introuvable", 404);
    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      throw new AppError('Ordre clos — modification impossible', 400);
    }

    const existing = await prisma.assemblyComponent.findUnique({
      where: {
        assemblyOrderId_productCategoryId: {
          assemblyOrderId: id,
          productCategoryId,
        },
      },
    });
    if (!existing) return res.json({ success: true }); // idempotent

    // Recup la derniere description connue via les events precedents
    // (INSTALLED/UPDATED) pour l'inclure dans le REMOVED.
    const lastKnown = await prisma.assemblyOrderEvent.findFirst({
      where: {
        assemblyOrderId: id,
        eventType: { in: ['COMPONENT_INSTALLED', 'COMPONENT_UPDATED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const lastDesc = (lastKnown?.payload as any)?.productDescription ?? null;

    await prisma.$transaction(async (tx) => {
      await tx.assemblyComponent.delete({ where: { id: existing.id } });
      await logAssemblyEvent(tx as any, id, 'COMPONENT_REMOVED', req.user, {
        productRef: existing.productReference,
        productDescription: lastDesc,
        serialNumber: existing.serialNumber,
        quantity: existing.quantity,
        productCategoryId,
      });
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ---------- Checklist ----------

/**
 * GET /assembly-orders/:id/checklist
 *
 * Cross-references the bill-of-materials owned by Stock (via the assembly
 * type matching the parent ProductionOrder's model) with what we've already
 * installed locally. Returns one line per BOM entry plus an `extras` array
 * for components installed outside the BOM.
 */
export async function checklist(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const order = await prisma.assemblyOrder.findUnique({
      where: { id },
      include: {
        productionOrder: { select: { model: true } },
        components: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) throw new AppError("Ordre d'assemblage introuvable", 404);

    const stock = stockClientFor(req.user.rawToken);
    const at = await stock.getAssemblyTypeByName(order.productionOrder.model);
    if (!at) {
      throw new AppError(
        `Nomenclature introuvable côté Stock pour « ${order.productionOrder.model} »`,
        404,
      );
    }

    // Fetch each BOM product's metadata (hasSerialNumber drives UI behaviour).
    // V1.1 batches: Stock should expose GET /products?ids= so we don't N+1.
    const productMetas = await Promise.all(
      at.items.map((it) => stock.getProduct(it.productId).catch(() => null)),
    );

    const installedByProduct = new Map<string, typeof order.components>();
    for (const c of order.components) {
      const arr = installedByProduct.get(c.productId) || [];
      arr.push(c);
      installedByProduct.set(c.productId, arr);
    }

    const lines = at.items.map((it, i) => {
      const meta = productMetas[i];
      const installed = installedByProduct.get(it.productId) || [];
      const installedQty = installed.reduce((sum, c) => sum + c.quantity, 0);
      return {
        productId: it.productId,
        productReference: it.product.reference,
        productDescription: it.product.description,
        // Type de piece (Equipement / Protection / Accessoire), orthogonal a la
        // localisation (partCategory : Tete/Pied). L'UI Factory groupe la
        // checklist par cette valeur; les lignes sans partType sont cachees
        // (decision explicite — voir docs).
        partType: it.product.partType ?? null,
        hasSerialNumber: meta?.hasSerialNumber ?? false,
        imageUrl: meta?.imageUrl ?? null,
        requiredQty: it.quantity,
        installedQty,
        complete: installedQty >= it.quantity,
        installed: installed.map((c) => ({
          id: c.id,
          serialNumber: c.serialNumber,
          quantity: c.quantity,
          installedAt: c.installedAt,
        })),
      };
    });

    // Components installed but not in the BOM
    const bomProductIds = new Set(at.items.map((it) => it.productId));
    const extras = order.components
      .filter((c) => !bomProductIds.has(c.productId))
      .map((c) => ({
        id: c.id,
        productId: c.productId,
        productReference: c.productReference,
        serialNumber: c.serialNumber,
        quantity: c.quantity,
        installedAt: c.installedAt,
      }));

    // Selections par ProductCategory (mode "matrice" : 1 ligne = 1 categorie).
    // Renvoie uniquement les composants qui ont un productCategoryId non null.
    const categorySelections = order.components
      .filter((c) => !!c.productCategoryId)
      .map((c) => ({
        componentId: c.id,
        productCategoryId: c.productCategoryId as string,
        productId: c.productId,
        productReference: c.productReference,
        serialNumber: c.serialNumber,
        quantity: c.quantity,
      }));

    const requiredLines = lines.filter((l) => !l.complete).length;
    res.json({
      success: true,
      data: {
        model: order.productionOrder.model,
        lines,
        extras,
        categorySelections,
        requiredCount: at.items.length,
        completeCount: at.items.length - requiredLines,
        qualityChecks: QUALITY_CHECKS,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ---------- History ----------

export async function history(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const events = await prisma.assemblyOrderEvent.findMany({
      where: { assemblyOrderId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
}

// ---------- Transitions ----------

/**
 * State machine for an assembly. The frontend only ever calls /transition;
 * direct PATCH on `status` is intentionally a no-op (cf. update()).
 *
 *   DRAFT       → IN_PROGRESS  (start)
 *   IN_PROGRESS → TESTING       (must have every BOM line complete)
 *   TESTING     → COMPLETED     (must have every quality check + internal number;
 *                                creates the Stock OUT movements)
 *   any non-terminal → CANCELLED
 */
export async function transition(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const body = transitionSchema.parse(req.body);
    const existing = await prisma.assemblyOrder.findUnique({
      where: { id },
      include: {
        productionOrder: { select: { model: true } },
        components: true,
      },
    });
    if (!existing) throw new AppError("Ordre d'assemblage introuvable", 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError('Ordre déjà clos', 400);
    }

    const validTransitions: Record<string, string[]> = {
      DRAFT: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['TESTING', 'CANCELLED'],
      TESTING: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    };
    if (!validTransitions[existing.status]?.includes(body.to)) {
      throw new AppError(`Transition ${existing.status} → ${body.to} interdite`, 400);
    }

    // ---- Transition-specific guards ----

    if (body.to === 'TESTING') {
      // Every BOM line must be 100% installed.
      const stock = stockClientFor(req.user.rawToken);
      const at = await stock.getAssemblyTypeByName(existing.productionOrder.model);
      if (!at) {
        throw new AppError('Nomenclature introuvable côté Stock', 404);
      }
      const installedByProduct = new Map<string, number>();
      for (const c of existing.components) {
        installedByProduct.set(
          c.productId,
          (installedByProduct.get(c.productId) ?? 0) + c.quantity,
        );
      }
      const missing = at.items.filter(
        (it) => (installedByProduct.get(it.productId) ?? 0) < it.quantity,
      );
      if (missing.length > 0) {
        throw new AppError(
          `${missing.length} composant(s) manquant(s) — assemblage incomplet`,
          400,
        );
      }
    }

    if (body.to === 'COMPLETED') {
      // Need internal number (from body or already stored).
      const finalInternal = body.internalNumber || existing.internalNumber;
      if (!finalInternal) {
        throw new AppError('Numéro interne requis pour valider la borne', 400);
      }
      // Need all quality checks ticked.
      const checks = (existing.qualityChecks as string[] | null) || [];
      const missing = REQUIRED_QUALITY_CHECK_IDS.filter((id) => !checks.includes(id));
      if (missing.length > 0) {
        throw new AppError(
          `${missing.length} contrôle(s) qualité manquant(s)`,
          400,
        );
      }
    }

    // ---- Apply transition ----

    if (body.to === 'COMPLETED') {
      // 1. Sum installed components per productId so we issue one movement
      //    per product (with optional serial numbers array).
      const stock = stockClientFor(req.user.rawToken);
      const atelier = await stock.getAtelierSite();

      type Group = { productId: string; quantity: number; serials: string[] };
      const grouped = new Map<string, Group>();
      for (const c of existing.components) {
        const g = grouped.get(c.productId) || {
          productId: c.productId,
          quantity: 0,
          serials: [],
        };
        g.quantity += c.quantity;
        if (c.serialNumber) g.serials.push(c.serialNumber);
        grouped.set(c.productId, g);
      }

      // 2. Fire the OUT movements. Pour chaque groupe :
      //    - Si le produit n'est PAS SN-trace : OUT quantity=g.quantity
      //    - Si le produit EST SN-trace : on ne compte que les composants
      //      qui ONT un SN renseigne. Le nombre de SN = quantity envoyee.
      //      Les composants sans SN sont SKIPPES (log warning). On resout
      //      chaque SN string -> serialItemId via Stock avant le OUT.
      //    Si le OUT plante, on bubble et on marque PAS COMPLETED.
      let movementsCreated = 0;
      for (const g of grouped.values()) {
        // On a besoin de savoir si le produit est SN-trace
        const meta = await stock.getProduct(g.productId).catch(() => null);
        const isSerialTracked = !!meta?.hasSerialNumber;

        if (!isSerialTracked) {
          // Cas simple : mouvement quantitatif
          await stock.createMovement({
            productId: g.productId,
            type: 'OUT',
            quantity: g.quantity,
            condition: 'NEW',
            movementDate: new Date().toISOString(),
            sourceSiteId: atelier.id,
            comment: `Assemblage ${body.internalNumber || existing.internalNumber} (${existing.productionOrder.model})`,
          });
          movementsCreated++;
          continue;
        }

        // Produit SN-trace : on ne compte que les composants avec SN
        const validSerials = g.serials.filter((s) => s.trim().length > 0);
        if (validSerials.length === 0) {
          // Aucun SN saisi pour ce produit SN-trace -> on skip le mouvement
          // Stock (on ne peut pas OUT une unite sans SN). Log pour audit.
          console.warn(
            `[assembly] SKIP OUT produit ${g.productId} : ${g.quantity} unite(s) sans SN sur assembly ${id}`,
          );
          continue;
        }

        // Resout les SN string -> serialItemIds via Stock
        const serialItems = await stock.getSerialItems(g.productId, { status: 'IN_STOCK' });
        const serialToId = new Map(
          serialItems.filter((s) => s.serialNumber).map((s) => [s.serialNumber!, s.id]),
        );
        const serialItemIds: string[] = [];
        const notFound: string[] = [];
        for (const sn of validSerials) {
          const sid = serialToId.get(sn);
          if (sid) serialItemIds.push(sid);
          else notFound.push(sn);
        }
        if (notFound.length > 0) {
          throw new AppError(
            `SN introuvables cote Stock pour produit ${g.productId} : ${notFound.join(', ')}`,
            400,
          );
        }

        await stock.createMovement({
          productId: g.productId,
          type: 'OUT',
          quantity: serialItemIds.length,
          condition: 'NEW',
          movementDate: new Date().toISOString(),
          sourceSiteId: atelier.id,
          comment: `Assemblage ${body.internalNumber || existing.internalNumber} (${existing.productionOrder.model})`,
          serialItemIds,
        });
        movementsCreated++;
      }

      // 3. Persist completion + log the event.
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.assemblyOrder.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            internalNumber: body.internalNumber || existing.internalNumber,
            completedAt: new Date(),
          },
          include: { components: true },
        });
        await logAssemblyEvent(tx as any, id, 'STATUS_CHANGED', req.user, {
          from: existing.status,
          to: 'COMPLETED',
        });
        await logAssemblyEvent(tx as any, id, 'COMPLETED', req.user, {
          internalNumber: u.internalNumber,
          movementsCreated,
        });
        return u;
      });

      // 4. Broadcast on the platform bus. Done AFTER the DB commit so a
      //    failed publish never leaves us in "event sent but state not
      //    persisted". A failed publish is logged and forgotten — the
      //    business operation succeeded, the bus is best-effort.
      //
      //    Subscribers (Bornes for sure, possibly BI/Stock later):
      //      factory.assembly_orders.completed
      void publishEvent(
        'assembly_orders',
        'completed',
        {
          id: updated.id,
          internalNumber: updated.internalNumber,
          productionOrderId: updated.productionOrderId,
          model: existing.productionOrder.model,
          completedAt: updated.completedAt,
          operator: updated.operatorName,
          movementsCreated,
          components: updated.components.map((c) => ({
            productId: c.productId,
            productReference: c.productReference,
            serialNumber: c.serialNumber,
            quantity: c.quantity,
          })),
        },
        req.user,
      );

      return res.json({ success: true, data: { order: updated, movementsCreated } });
    }

    if (body.to === 'CANCELLED') {
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.assemblyOrder.update({
          where: { id },
          data: { status: 'CANCELLED' },
          include: { components: true },
        });
        await logAssemblyEvent(tx as any, id, 'STATUS_CHANGED', req.user, {
          from: existing.status,
          to: 'CANCELLED',
        });
        await logAssemblyEvent(tx as any, id, 'CANCELLED', req.user, {
          reason: body.reason || null,
        });
        return u;
      });

      void publishEvent(
        'assembly_orders',
        'cancelled',
        {
          id: updated.id,
          internalNumber: updated.internalNumber,
          productionOrderId: updated.productionOrderId,
          model: existing.productionOrder.model,
          reason: body.reason || null,
        },
        req.user,
      );

      return res.json({ success: true, data: { order: updated } });
    }

    // DRAFT → IN_PROGRESS, IN_PROGRESS → TESTING, TESTING → IN_PROGRESS
    const updated = await prisma.$transaction(async (tx) => {
      const data: any = { status: body.to };
      if (body.to === 'IN_PROGRESS' && !existing.startedAt) {
        data.startedAt = new Date();
        data.operatorId = req.user.id;
        data.operatorName = req.user.fullName || req.user.username;
      }
      const u = await tx.assemblyOrder.update({
        where: { id },
        data,
        include: { components: true },
      });
      await logAssemblyEvent(tx as any, id, 'STATUS_CHANGED', req.user, {
        from: existing.status,
        to: body.to,
      });
      if (body.to === 'IN_PROGRESS' && !existing.startedAt) {
        await logAssemblyEvent(tx as any, id, 'STARTED', req.user);
      }
      return u;
    });

    res.json({ success: true, data: { order: updated } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
    }
    next(err);
  }
}
