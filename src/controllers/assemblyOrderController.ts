import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';

const updateSchema = z.object({
  status: z.enum(['DRAFT', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED']).optional(),
  internalNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const addComponentSchema = z.object({
  productId: z.string().min(1),
  productReference: z.string().min(1),
  serialNumber: z.string().optional().nullable(),
  quantity: z.number().int().positive().default(1),
});

// GET /assembly-orders/:id
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

// PATCH /assembly-orders/:id
export async function update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const body = updateSchema.parse(req.body);
    const existing = await prisma.assemblyOrder.findUnique({ where: { id } });
    if (!existing) throw new AppError("Ordre d'assemblage introuvable", 404);

    const data: any = {};
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.internalNumber !== undefined) data.internalNumber = body.internalNumber;
    if (body.status !== undefined) {
      data.status = body.status;
      // Lifecycle timestamps. We set them once on first transition.
      if (body.status === 'IN_PROGRESS' && !existing.startedAt) {
        data.startedAt = new Date();
        data.operatorId = req.user.id;
        data.operatorName = req.user.fullName || req.user.username;
      }
      if (body.status === 'COMPLETED' && !existing.completedAt) {
        data.completedAt = new Date();
      }
    }

    const order = await prisma.assemblyOrder.update({
      where: { id },
      data,
      include: { components: true },
    });
    res.json({ success: true, data: order });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
    }
    next(err);
  }
}

// POST /assembly-orders/:id/components
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
      throw new AppError("Ordre clos: impossible d'ajouter un composant", 400);
    }

    const component = await prisma.assemblyComponent.create({
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

    res.status(201).json({ success: true, data: component });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0]?.message || 'Données invalides', 400));
    }
    next(err);
  }
}

// DELETE /assembly-orders/:id/components/:componentId
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
    });
    if (!component || component.assemblyOrderId !== id) {
      throw new AppError('Composant introuvable', 404);
    }
    await prisma.assemblyComponent.delete({ where: { id: component.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
