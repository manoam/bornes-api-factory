import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';
import {
  getBornesSnapshot,
  isConfigured as isBornesConfigured,
  type BorneRow,
} from '../services/bornesClient';

/**
 * GET /produced-bornes
 *
 * Liste les assembly_orders en statut COMPLETED, enrichies avec le
 * matching contre l'API Bornes:
 *
 *   - parcMatch.found      : true si on retrouve `internalNumber` dans Bornes
 *   - parcMatch.borne      : la row Bornes correspondante (ou null)
 *   - parcMatch.error      : message si l'API Bornes a echoue (snapshot indispo)
 *
 * Le matching utilise `internalNumber` = `numero_formated`. Snapshot Bornes
 * en cache 60s.
 */
export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const search = (req.query.search as string | undefined)?.trim() || undefined;
    const model = (req.query.model as string | undefined)?.trim() || undefined;
    const syncFilter = (req.query.sync as string | undefined) as
      | 'matched'
      | 'unmatched'
      | undefined;
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || '50', 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0);

    const where: any = { status: 'COMPLETED' };
    if (model) where.productionOrder = { model };
    if (search) {
      where.OR = [
        { internalNumber: { contains: search, mode: 'insensitive' } },
        { productionOrder: { model: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.assemblyOrder.findMany({
        where,
        include: {
          productionOrder: { select: { id: true, model: true } },
          _count: { select: { components: true } },
        },
        orderBy: { completedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.assemblyOrder.count({ where }),
    ]);

    // Pull the Bornes snapshot once for the whole batch. If the API is
    // unreachable we still return the Factory data; clients see parcMatch
    // with an error.
    let snapshotBy: Map<string, BorneRow> | null = null;
    let snapshotError: string | null = null;
    let snapshotCount = 0;
    if (isBornesConfigured()) {
      try {
        const snap = await getBornesSnapshot();
        snapshotBy = snap.byInternal;
        snapshotCount = snap.count;
      } catch (err) {
        snapshotError = err instanceof Error ? err.message : String(err);
      }
    } else {
      snapshotError = 'BORNES_API_URL / BORNES_WS_TOKEN non configurés';
    }

    const data = rows.map((r) => {
      const internal = r.internalNumber?.trim() || null;
      const matched = internal && snapshotBy ? snapshotBy.get(internal) || null : null;
      return {
        id: r.id,
        internalNumber: r.internalNumber,
        operatorName: r.operatorName,
        completedAt: r.completedAt,
        startedAt: r.startedAt,
        componentsInstalled: r._count.components,
        productionOrder: r.productionOrder,
        parcMatch: {
          found: !!matched,
          borne: matched
            ? {
                id: matched.id,
                numero_formated: matched.numero_formated,
                numero_serie: matched.numero_serie,
                gamme_nom: matched.gamme_nom,
                etat_nom: matched.etat_nom,
                parc_nom: matched.parc_nom,
                localisation: matched.localisation,
                antenne_ville: matched.antenne_ville,
                client_enseigne: matched.client_enseigne,
                sortie_atelier: matched.sortie_atelier,
              }
            : null,
          error: snapshotError,
        },
      };
    });

    // Filtre sync appliqué APRES enrichissement (snapshot Bornes ne sait
    // rien des id Factory). Pour la prod on prefererait un join SQL via
    // une vue materialisee, mais pour les volumes actuels c'est OK.
    let filtered = data;
    if (syncFilter === 'matched') filtered = data.filter((d) => d.parcMatch.found);
    if (syncFilter === 'unmatched') filtered = data.filter((d) => !d.parcMatch.found);

    res.json({
      success: true,
      data: filtered,
      pagination: { total, limit, offset },
      bornesSync: {
        configured: isBornesConfigured(),
        snapshotCount,
        snapshotError,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /produced-bornes/:internalNumber/parc
 *
 * Renvoie la row brute de l'API Bornes pour ce numero_formated, ou 404
 * si non trouve. Utilise par la page detail d'une borne produite pour
 * afficher le bloc "Statut dans le parc".
 */
export async function getParcInfo(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!isBornesConfigured()) {
      throw new AppError('API Bornes non configurée côté Factory', 503);
    }
    const internal = String(req.params.internalNumber).trim();
    const snap = await getBornesSnapshot();
    const borne = snap.byInternal.get(internal) || null;
    if (!borne) throw new AppError('Borne non trouvée dans le parc', 404);
    res.json({ success: true, data: borne });
  } catch (err) {
    next(err);
  }
}
