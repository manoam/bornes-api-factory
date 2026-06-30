import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';
import { logAssemblyEvent } from '../services/assemblyEventLog';
import { stockClientFor } from '../services/stockClient';
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
  serialNumber: z.string().optional().nullable(),
  quantity: z.number().int().positive().default(1),
});

const transitionSchema = z.object({
  to: z.enum(['IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED']),
  internalNumber: z.string().optional(),
  reason: z.string().optional(),
});

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

    await prisma.$transaction(async (tx) => {
      await tx.assemblyComponent.delete({ where: { id: component.id } });
      await logAssemblyEvent(tx as any, id, 'COMPONENT_REMOVED', req.user, {
        productRef: component.productReference,
        serialNumber: component.serialNumber,
        quantity: component.quantity,
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

    const requiredLines = lines.filter((l) => !l.complete).length;
    res.json({
      success: true,
      data: {
        model: order.productionOrder.model,
        lines,
        extras,
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

      // 2. Fire the OUT movements. If any fails, we bubble the error and
      //    DO NOT mark the assembly as completed — operator can retry.
      let movementsCreated = 0;
      for (const g of grouped.values()) {
        await stock.createMovement({
          productId: g.productId,
          type: 'OUT',
          quantity: g.quantity,
          condition: 'NEW',
          movementDate: new Date().toISOString(),
          sourceSiteId: atelier.id,
          comment: `Assemblage ${body.internalNumber || existing.internalNumber} (${existing.productionOrder.model})`,
          ...(g.serials.length > 0 ? { serialNumbers: g.serials } : {}),
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
