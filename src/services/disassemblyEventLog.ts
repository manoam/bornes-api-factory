import { Prisma, PrismaClient } from '@prisma/client';
import { AuthenticatedUser } from '../types/auth';

/**
 * Audit log append-only pour les demontages. Meme pattern que
 * repairEventLog / assemblyEventLog.
 */
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export type DisassemblyEventType =
  | 'STARTED'
  | 'STATUS_CHANGED'
  | 'REASON_UPDATED'
  | 'PRIORITY_UPDATED'
  | 'COMPONENT_RECOVERED'
  | 'COMPONENT_REVERTED'
  | 'NOTES_UPDATED'
  | 'COMPLETED'
  | 'CANCELLED';

export async function logDisassemblyEvent(
  client: PrismaClient | TxClient,
  disassemblyId: string,
  eventType: DisassemblyEventType,
  actor: Pick<AuthenticatedUser, 'id' | 'fullName' | 'username'> | null,
  payload?: Prisma.InputJsonValue,
) {
  await client.disassemblyEvent.create({
    data: {
      disassemblyId,
      eventType,
      payload: payload ?? Prisma.JsonNull,
      actorId: actor?.id ?? null,
      actorName: actor ? actor.fullName || actor.username : null,
    },
  });
}
