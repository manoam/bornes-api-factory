import { Prisma, PrismaClient } from '@prisma/client';
import { AuthenticatedUser } from '../types/auth';

/**
 * Append-only audit log writer for assembly orders.
 *
 * Accepts either the global Prisma client or a transaction client, so we
 * can log inside a `$transaction(async tx => …)` block and have the event
 * rolled back atomically with the operation it describes.
 *
 * The event types are documented in schema.prisma above the model. Adding a
 * new event kind is intentionally just a new string — no migration required.
 */
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export type AssemblyEventType =
  | 'STARTED'
  | 'STATUS_CHANGED'
  | 'COMPONENT_INSTALLED'
  | 'COMPONENT_UPDATED'
  | 'COMPONENT_REMOVED'
  | 'NOTES_UPDATED'
  | 'INTERNAL_NUMBER_SET'
  | 'QUALITY_CHECKED'
  | 'QUALITY_UNCHECKED'
  | 'COMPLETED'
  | 'CANCELLED';

export async function logAssemblyEvent(
  client: PrismaClient | TxClient,
  assemblyOrderId: string,
  eventType: AssemblyEventType,
  actor: Pick<AuthenticatedUser, 'id' | 'fullName' | 'username'> | null,
  payload?: Prisma.InputJsonValue,
) {
  await client.assemblyOrderEvent.create({
    data: {
      assemblyOrderId,
      eventType,
      payload: payload ?? Prisma.JsonNull,
      actorId: actor?.id ?? null,
      actorName: actor ? actor.fullName || actor.username : null,
    },
  });
}
