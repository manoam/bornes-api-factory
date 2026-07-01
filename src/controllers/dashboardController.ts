import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types/auth';
import {
  getBornesSnapshot,
  isConfigured as isBornesConfigured,
} from '../services/bornesClient';

/**
 * GET /dashboard/stats
 *
 * Agrège en une seule réponse tout ce que le dashboard Factory affiche:
 *   - production   : KPIs par statut d'assembly + count OF ouverts
 *   - parc         : count total COMPLETED + croisement avec API Bornes
 *                    (found / not found / snapshot indispo)
 *   - cadence30d   : nb de bornes validées par jour sur les 30 derniers jours
 *   - myInProgress : assemblages IN_PROGRESS de l'utilisateur courant
 *
 * Un seul call = un seul spinner côté client.
 */
export async function stats(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    // ─── Production ──────────────────────────────────────────────────────
    const [assemblyStats, ordersOpen] = await Promise.all([
      prisma.assemblyOrder.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.productionOrder.count({
        where: { status: { in: ['PLANNED', 'IN_PROGRESS'] } },
      }),
    ]);

    const byStatus: Record<string, number> = {
      DRAFT: 0,
      IN_PROGRESS: 0,
      TESTING: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    for (const s of assemblyStats) byStatus[s.status] = s._count._all;
    const inWorkshop = byStatus.IN_PROGRESS + byStatus.TESTING;

    // ─── Parc (croisement avec API Bornes) ───────────────────────────────
    const completed = await prisma.assemblyOrder.findMany({
      where: { status: 'COMPLETED' },
      select: { internalNumber: true },
    });
    const producedTotal = completed.length;

    let syncedInParc = 0;
    let notInParc = 0;
    let parcSyncError: string | null = null;

    if (!isBornesConfigured()) {
      parcSyncError = 'API Bornes non configurée';
    } else if (producedTotal > 0) {
      try {
        const snap = await getBornesSnapshot();
        for (const c of completed) {
          const key = c.internalNumber?.trim();
          if (!key) {
            notInParc++;
            continue;
          }
          if (snap.byInternal.has(key)) syncedInParc++;
          else notInParc++;
        }
      } catch (err) {
        parcSyncError = err instanceof Error ? err.message : String(err);
      }
    }

    // ─── Cadence 30j ─────────────────────────────────────────────────────
    // On agrège les bornes validées par jour en Postgres. `date_trunc` en
    // UTC — la timezone locale n'a pas d'importance pour un sparkline
    // (les décalages d'1h à minuit sont cosmétiques).
    const cadenceStart = new Date();
    cadenceStart.setDate(cadenceStart.getDate() - 29);
    cadenceStart.setHours(0, 0, 0, 0);

    const cadenceRows = await prisma.$queryRawUnsafe<
      { day: Date; count: bigint }[]
    >(
      `SELECT date_trunc('day', "completedAt") AS day, COUNT(*)::bigint AS count
       FROM "assembly_orders"
       WHERE "status" = 'COMPLETED' AND "completedAt" >= $1
       GROUP BY day
       ORDER BY day`,
      cadenceStart,
    );

    const countByDay = new Map<string, number>();
    for (const r of cadenceRows) {
      const key = r.day.toISOString().slice(0, 10);
      countByDay.set(key, Number(r.count));
    }
    const cadence30d: { date: string; count: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(cadenceStart);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      cadence30d.push({ date: key, count: countByDay.get(key) ?? 0 });
    }

    // ─── Mes assemblages en cours ────────────────────────────────────────
    const myInProgress = await prisma.assemblyOrder.findMany({
      where: {
        operatorId: req.user.id,
        status: { in: ['IN_PROGRESS', 'TESTING'] },
      },
      include: {
        productionOrder: { select: { id: true, model: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });

    res.json({
      success: true,
      data: {
        production: {
          ordersOpen,
          inWorkshop,
          completed: byStatus.COMPLETED,
          byStatus,
        },
        parc: {
          producedTotal,
          syncedInParc,
          notInParc,
          syncError: parcSyncError,
        },
        cadence30d,
        myInProgress: myInProgress.map((a) => ({
          id: a.id,
          internalNumber: a.internalNumber,
          status: a.status,
          startedAt: a.startedAt,
          productionOrder: a.productionOrder,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}
