import { Prisma, PrismaClient } from '@prisma/client';
import { AuthenticatedUser } from '../types/auth';

/**
 * Audit log append-only pour les reconditionnements. Meme pattern que
 * repairEventLog / disassemblyEventLog / assemblyEventLog.
 */
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export type RefurbishmentEventType =
  | 'STARTED'
  | 'STATUS_CHANGED'
  | 'REASON_UPDATED'
  | 'COMPONENT_REMOVED'
  | 'COMPONENT_INSTALLED'
  | 'COMPONENT_REVERTED'
  | 'NOTES_UPDATED'
  | 'QUALITY_CHECKED'
  | 'QUALITY_UNCHECKED'
  | 'COMPLETED'
  | 'CANCELLED';

export async function logRefurbishmentEvent(
  client: PrismaClient | TxClient,
  refurbishmentId: string,
  eventType: RefurbishmentEventType,
  actor: Pick<AuthenticatedUser, 'id' | 'fullName' | 'username'> | null,
  payload?: Prisma.InputJsonValue,
) {
  await client.refurbishmentEvent.create({
    data: {
      refurbishmentId,
      eventType,
      payload: payload ?? Prisma.JsonNull,
      actorId: actor?.id ?? null,
      actorName: actor ? actor.fullName || actor.username : null,
    },
  });
}
