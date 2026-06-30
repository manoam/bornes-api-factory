import { Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

/**
 * Public-ish read of the local users mirror.
 *
 * Used by the frontend OperatorAvatar to lookup a user's photoNom (or
 * full name) from a Keycloak identity or a stored operator name. Email
 * is intentionally exposed since the platform's users table is already
 * shared between apps — Factory isn't introducing a new leak.
 */

// GET /api/users-ref?search=...
export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const search = (req.query.search as string | undefined)?.trim();
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || '200', 10) || 200, 1),
      500,
    );

    const where: any = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { nom: { contains: search, mode: 'insensitive' } },
        { prenom: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
      ];
    }

    const users = await prisma.userRef.findMany({
      where,
      select: {
        id: true,
        email: true,
        nom: true,
        prenom: true,
        username: true,
        photo_nom: true,
        photo_url: true,
      },
      orderBy: [{ nom: 'asc' }, { prenom: 'asc' }],
      take: limit,
    });
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
}

// GET /api/users-ref/:id
export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) throw new AppError('ID invalide', 400);
    const user = await prisma.userRef.findUnique({ where: { id } });
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}
