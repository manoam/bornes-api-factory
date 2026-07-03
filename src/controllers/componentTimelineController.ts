import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types/auth';

/**
 * Historique d'une piece serialisee dans la vie de Factory.
 *
 * On croise 4 sources : assemblages initiaux, reparations,
 * reconditionnements, demontages. Tout est aggrege dans une timeline
 * triee du plus recent au plus ancien.
 *
 * Filtrage : on cherche par (productId OU productReference) + serialNumber.
 * On accepte productReference seul si le SN est unique cote reference
 * (utile pour un scan a la vole quand on n'a pas l'id).
 */

type Kind =
  | 'ASSEMBLED'
  | 'REPAIR_REMOVED'
  | 'REPAIR_INSTALLED'
  | 'REFURB_REMOVED'
  | 'REFURB_INSTALLED'
  | 'DISASSEMBLED';

interface TimelineEvent {
  kind: Kind;
  at: string;
  borneInternalNumber: string;
  orderId: string;
  orderStatus: string | null;
  operatorName: string | null;
  disposition: string | null;
  quantity: number;
  productReference: string;
  productId: string;
  // Route front vers la fiche source.
  link: string;
}

export async function getTimeline(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const serialNumber = String(req.query.serialNumber || '').trim();
    const productRef = String(req.query.productReference || '').trim();
    const productId = String(req.query.productId || '').trim();

    if (!serialNumber) {
      throw new AppError('Parametre serialNumber requis', 400);
    }
    if (!productRef && !productId) {
      throw new AppError('Parametre productReference ou productId requis', 400);
    }

    // Filtre commun : SN + (productId OU productReference)
    const productFilter = productId
      ? { productId }
      : { productReference: productRef };

    const [assemblies, repairs, refurbs, disassemblies] = await Promise.all([
      prisma.assemblyComponent.findMany({
        where: { serialNumber, ...productFilter },
        include: {
          assemblyOrder: {
            include: { productionOrder: { select: { model: true } } },
          },
        },
      }),
      prisma.repairComponent.findMany({
        where: { serialNumber, ...productFilter },
        include: { repairOrder: true },
      }),
      prisma.refurbishmentComponent.findMany({
        where: { serialNumber, ...productFilter },
        include: { refurbishment: true },
      }),
      prisma.disassemblyComponent.findMany({
        where: { serialNumber, ...productFilter },
        include: { disassembly: true },
      }),
    ]);

    const events: TimelineEvent[] = [];

    for (const a of assemblies) {
      const ao = a.assemblyOrder;
      events.push({
        kind: 'ASSEMBLED',
        // Prefere completedAt (installation effective), fallback createdAt.
        at: (ao.completedAt || a.createdAt).toISOString(),
        borneInternalNumber: ao.internalNumber || '—',
        orderId: ao.id,
        orderStatus: ao.status,
        operatorName: ao.operatorName || null,
        disposition: null,
        quantity: a.quantity,
        productReference: a.productReference,
        productId: a.productId,
        link: `/produced-bornes/${ao.id}`,
      });
    }

    for (const c of repairs) {
      const ro = c.repairOrder;
      events.push({
        kind: c.action === 'REMOVED' ? 'REPAIR_REMOVED' : 'REPAIR_INSTALLED',
        at: c.createdAt.toISOString(),
        borneInternalNumber: ro.borneInternalNumber,
        orderId: ro.id,
        orderStatus: ro.status,
        operatorName: ro.operatorName || null,
        disposition: c.disposition,
        quantity: c.quantity,
        productReference: c.productReference,
        productId: c.productId,
        link: `/repair-orders/${ro.id}`,
      });
    }

    for (const c of refurbs) {
      const rf = c.refurbishment;
      events.push({
        kind: c.action === 'REMOVED' ? 'REFURB_REMOVED' : 'REFURB_INSTALLED',
        at: c.createdAt.toISOString(),
        borneInternalNumber: rf.borneInternalNumber,
        orderId: rf.id,
        orderStatus: rf.status,
        operatorName: rf.operatorName || null,
        disposition: c.disposition,
        quantity: c.quantity,
        productReference: c.productReference,
        productId: c.productId,
        link: `/refurbishments/${rf.id}`,
      });
    }

    for (const c of disassemblies) {
      const dis = c.disassembly;
      events.push({
        kind: 'DISASSEMBLED',
        at: c.createdAt.toISOString(),
        borneInternalNumber: dis.borneInternalNumber,
        orderId: dis.id,
        orderStatus: dis.status,
        operatorName: dis.operatorName || null,
        disposition: c.disposition,
        quantity: c.quantity,
        productReference: c.productReference,
        productId: c.productId,
        link: `/disassemblies/${dis.id}`,
      });
    }

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    // Meta : premiere & derniere occurrence, borne actuelle presumee (dernier
    // event installe non annule apres tout event retire).
    const first = events[events.length - 1] || null;
    const last = events[0] || null;

    // On cherche la borne actuelle : le dernier evenement d'installation
    // (ASSEMBLED, REPAIR_INSTALLED, REFURB_INSTALLED) dont l'ordre n'a
    // pas ete annule, en supposant qu'aucun retrait posterieur n'a eu
    // lieu sur la meme borne.
    let currentBorne: string | null = null;
    for (const e of events) {
      const isInstall =
        e.kind === 'ASSEMBLED' ||
        e.kind === 'REPAIR_INSTALLED' ||
        e.kind === 'REFURB_INSTALLED';
      const isRemove =
        e.kind === 'REPAIR_REMOVED' ||
        e.kind === 'REFURB_REMOVED' ||
        e.kind === 'DISASSEMBLED';
      if (isRemove) break; // dernier retrait connu → piece n'est plus sur la borne
      if (isInstall && e.orderStatus !== 'CANCELLED') {
        currentBorne = e.borneInternalNumber;
        break;
      }
    }

    res.json({
      success: true,
      data: {
        serialNumber,
        productReference: productRef || last?.productReference || first?.productReference || null,
        productId: productId || last?.productId || first?.productId || null,
        currentBorne,
        firstSeenAt: first?.at || null,
        lastEventAt: last?.at || null,
        totalEvents: events.length,
        events,
      },
    });
  } catch (err) {
    next(err);
  }
}
