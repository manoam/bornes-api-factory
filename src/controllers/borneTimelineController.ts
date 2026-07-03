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
 * Vie d'une borne physique dans Factory. Une ligne = un chantier
 * (assemblage / reparation / reconditionnement / demontage). Pour voir
 * le detail des composants d'un chantier, on clique et on tombe sur sa
 * fiche.
 *
 * Cle de recherche : borneInternalNumber (ex "K001"). On ne fait pas de
 * fuzzy — c'est un match exact.
 *
 * On complete avec un aperçu Bornes (l'app parc) pour afficher l'etat
 * actuel dans la location (gamme, client, antenne). Optionnel : si
 * l'API Bornes n'est pas configuree, on renvoie juste ce que Factory
 * connait.
 */

type Kind = 'ASSEMBLY' | 'REPAIR' | 'REFURBISHMENT' | 'DISASSEMBLY';

interface TimelineEvent {
  kind: Kind;
  id: string;
  status: string;
  at: string;
  operatorName: string | null;
  createdByName: string | null;
  title: string;
  subtitle: string | null;
  componentsCount: number;
  link: string;
}

export async function getBorneTimeline(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const internal = String(req.params.internal || '').trim();
    if (!internal) throw new AppError('N° borne requis', 400);

    // Chantiers Factory.
    const [assemblies, repairs, refurbs, disassemblies] = await Promise.all([
      prisma.assemblyOrder.findMany({
        where: { internalNumber: internal },
        include: {
          productionOrder: { select: { model: true } },
          _count: { select: { components: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.repairOrder.findMany({
        where: { borneInternalNumber: internal },
        include: { _count: { select: { components: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.refurbishment.findMany({
        where: { borneInternalNumber: internal },
        include: { _count: { select: { components: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.disassembly.findMany({
        where: { borneInternalNumber: internal },
        include: { _count: { select: { components: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const events: TimelineEvent[] = [];

    for (const a of assemblies) {
      events.push({
        kind: 'ASSEMBLY',
        id: a.id,
        status: a.status,
        // Prefere completedAt (assemblage valide) sinon createdAt.
        at: (a.completedAt || a.startedAt || a.createdAt).toISOString(),
        operatorName: a.operatorName || null,
        createdByName: null,
        title: `Assemblage ${a.productionOrder.model}`,
        subtitle: a.status === 'COMPLETED' ? 'Borne assemblée' : `Statut : ${a.status}`,
        componentsCount: a._count.components,
        link: `/produced-bornes/${a.id}`,
      });
    }

    for (const r of repairs) {
      events.push({
        kind: 'REPAIR',
        id: r.id,
        status: r.status,
        at: (r.completedAt || r.startedAt || r.createdAt).toISOString(),
        operatorName: r.operatorName || null,
        createdByName: r.createdByName || null,
        title: 'Réparation',
        subtitle: r.diagnosis || null,
        componentsCount: r._count.components,
        link: `/repair-orders/${r.id}`,
      });
    }

    for (const rf of refurbs) {
      events.push({
        kind: 'REFURBISHMENT',
        id: rf.id,
        status: rf.status,
        at: (rf.completedAt || rf.startedAt || rf.createdAt).toISOString(),
        operatorName: rf.operatorName || null,
        createdByName: rf.createdByName || null,
        title: 'Reconditionnement',
        subtitle: rf.reason || null,
        componentsCount: rf._count.components,
        link: `/refurbishments/${rf.id}`,
      });
    }

    for (const d of disassemblies) {
      events.push({
        kind: 'DISASSEMBLY',
        id: d.id,
        status: d.status,
        at: (d.completedAt || d.startedAt || d.createdAt).toISOString(),
        operatorName: d.operatorName || null,
        createdByName: d.createdByName || null,
        title: 'Démontage',
        subtitle: d.reason || null,
        componentsCount: d._count.components,
        link: `/disassemblies/${d.id}`,
      });
    }

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    // Meta.
    const first = events[events.length - 1] || null;
    const factoryAssembly = assemblies[0] || null;
    const model = factoryAssembly?.productionOrder.model || null;

    // Parc : etat actuel dans l'app Bornes.
    let parcBorne: BorneRow | null = null;
    let parcError: string | null = null;
    if (isBornesConfigured()) {
      try {
        const snap = await getBornesSnapshot();
        parcBorne = snap.byInternal.get(internal) || null;
      } catch (err) {
        parcError = err instanceof Error ? err.message : String(err);
      }
    } else {
      parcError = 'API Bornes non configurée';
    }

    const sourceApp = factoryAssembly ? 'factory' : parcBorne ? 'bornes' : 'unknown';

    res.json({
      success: true,
      data: {
        internalNumber: internal,
        model,
        sourceApp,
        parcBorne,
        parcError,
        firstSeenAt: first?.at || null,
        lastEventAt: events[0]?.at || null,
        totalEvents: events.length,
        events,
      },
    });
  } catch (err) {
    next(err);
  }
}
