import { Prisma, PrismaClient } from '@prisma/client';
import { AuthenticatedUser } from '../types/auth';

/**
 * Audit log append-only pour les ordres de reparation. Meme pattern que
 * assemblyEventLog — voir ce module pour la doc detaillee.
 */
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export type RepairEventType =
  | 'STARTED'
  | 'STATUS_CHANGED'
  | 'DIAGNOSIS_UPDATED'
  | 'DIAGNOSIS_SOURCE_UPDATED'
  | 'PRIORITY_UPDATED'
  | 'ON_HOLD'
  | 'RESUMED'
  // V2 — composant : lignes d'intervention typees (REPLACED / CHECKED / DIAGNOSED)
  | 'COMPONENT_ADDED'
  | 'COMPONENT_REVERTED'
  // V1 (conservees pour l'historique existant)
  | 'COMPONENT_REMOVED'
  | 'COMPONENT_INSTALLED'
  | 'NOTES_UPDATED'
  | 'REPORT_UPDATED'
  | 'QUALITY_CHECKED'
  | 'QUALITY_UNCHECKED'
  | 'ATTACHMENT_ADDED'
  | 'ATTACHMENT_REMOVED'
  | 'COMPLETED'
  | 'CANCELLED';

export async function logRepairEvent(
  client: PrismaClient | TxClient,
  repairOrderId: string,
  eventType: RepairEventType,
  actor: Pick<AuthenticatedUser, 'id' | 'fullName' | 'username'> | null,
  payload?: Prisma.InputJsonValue,
) {
  await client.repairOrderEvent.create({
    data: {
      repairOrderId,
      eventType,
      payload: payload ?? Prisma.JsonNull,
      actorId: actor?.id ?? null,
      actorName: actor ? actor.fullName || actor.username : null,
    },
  });
}
