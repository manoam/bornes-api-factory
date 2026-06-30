import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';
import { stockClientFor } from '../services/stockClient';

const createSchema = z.object({
  model: z.string().min(1, 'Modèle requis'),
  quantity: z.number().int().positive('Quantité doit être > 0'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
  reason: z.string().optional().nullable(),
  targetDate: z.string().datetime().optional().nullable(),
});

const updateSchema = z.object({
  model: z.string().min(1).optional(),
  quantity: z.number().int().positive().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
  status: z.enum(['DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  reason: z.string().optional().nullable(),
  targetDate: z.string().datetime().optional().nullable(),
});

// GET /production-orders
export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const status = (req.query.status as string) || undefined;
    const orders = await prisma.productionOrder.findMany({
      where: status ? { status: status as any } : {},
      include: {
        _count: { select: { assemblyOrders: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: orders });
  } catch (err) {
    next(err);
  }
}

// GET /production-orders/:id
export async function get(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const order = await prisma.productionOrder.findUnique({
      where: { id },
      include: {
        assemblyOrders: {
          orderBy: { createdAt: 'asc' },
          include: { _count: { select: { components: true } } },
        },
      },
    });
    if (!order) throw new AppError('Ordre de fabrication introuvable', 404);
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
}

// POST /production-orders
export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const body = createSchema.parse(req.body);
    const order = await prisma.productionOrder.create({
      data: {
        model: body.model,
        quantity: body.quantity,
        priority: body.priority || 'NORMAL',
        reason: body.reason || null,
        targetDate: body.targetDate ? new Date(body.targetDate) : null,
        createdById: req.user.id,
        createdByName: req.user.fullName || req.user.username,
      },
    });
    res.status(201).json({ success: true, data: order });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
    }
    next(err);
  }
}

// PATCH /production-orders/:id
export async function update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const body = updateSchema.parse(req.body);
    const existing = await prisma.productionOrder.findUnique({
      where: { id },
    });
    if (!existing) throw new AppError('Ordre de fabrication introuvable', 404);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new AppError(
        `Impossible de modifier un ordre ${existing.status === 'COMPLETED' ? 'terminé' : 'annulé'}`,
        400,
      );
    }
    const order = await prisma.productionOrder.update({
      where: { id },
      data: {
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.targetDate !== undefined
          ? { targetDate: body.targetDate ? new Date(body.targetDate) : null }
          : {}),
      },
    });
    res.json({ success: true, data: order });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
    }
    next(err);
  }
}

/**
 * POST /production-orders/:id/plan
 *
 * Spawn one AssemblyOrder per unit. Idempotent: if assemblies already
 * exist, we don't recreate them. Status transitions DRAFT → PLANNED.
 */
export async function plan(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const order = await prisma.productionOrder.findUnique({
      where: { id },
      include: { assemblyOrders: { select: { id: true } } },
    });
    if (!order) throw new AppError('Ordre de fabrication introuvable', 404);
    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      throw new AppError('Ordre déjà clos', 400);
    }

    const existing = order.assemblyOrders.length;
    const missing = order.quantity - existing;
    if (missing > 0) {
      await prisma.assemblyOrder.createMany({
        data: Array.from({ length: missing }, () => ({
          productionOrderId: order.id,
        })),
      });
    }

    const updated = await prisma.productionOrder.update({
      where: { id: order.id },
      data: { status: order.status === 'DRAFT' ? 'PLANNED' : order.status },
      include: { assemblyOrders: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /production-orders/:id/requirements
 *
 * Computes the component requirements for the order based on the
 * matching assembly_type on the Stock side, and compares against
 * current Stock availability.
 *
 * Returns { items: [{ productId, reference, neededPerUnit, totalNeeded,
 *                     available, missing }] }
 */
export async function requirements(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = String(req.params.id);
    const order = await prisma.productionOrder.findUnique({
      where: { id },
    });
    if (!order) throw new AppError('Ordre de fabrication introuvable', 404);

    const stock = stockClientFor(req.user.rawToken);
    const assemblyType = await stock.getAssemblyTypeByName(order.model);
    if (!assemblyType) {
      throw new AppError(
        `Nomenclature introuvable côté Stock pour le modèle « ${order.model} »`,
        404,
      );
    }

    const stocks = await stock.getStocks();
    const availableByProduct = new Map<string, number>();
    for (const row of stocks) {
      const prev = availableByProduct.get(row.productId) ?? 0;
      availableByProduct.set(row.productId, prev + row.quantityNew + row.quantityUsed);
    }

    const items = assemblyType.items.map((item) => {
      const totalNeeded = item.quantity * order.quantity;
      const available = availableByProduct.get(item.productId) ?? 0;
      return {
        productId: item.productId,
        reference: item.product.reference,
        description: item.product.description,
        neededPerUnit: item.quantity,
        totalNeeded,
        available,
        missing: Math.max(0, totalNeeded - available),
      };
    });

    res.json({
      success: true,
      data: {
        model: order.model,
        quantity: order.quantity,
        items,
        // Quick UI flags
        fullyAvailable: items.every((it) => it.missing === 0),
        missingCount: items.filter((it) => it.missing > 0).length,
      },
    });
  } catch (err) {
    next(err);
  }
}
