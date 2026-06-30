import amqp from 'amqplib';

/**
 * Factory's RabbitMQ adapter — same shape as Stock's so events flow over the
 * shared platform.events exchange and any Konitys app can consume them.
 *
 * Connection lifecycle:
 *   - connect() called at boot (index.ts). If RABBITMQ_URL isn't set, we
 *     log a warning and continue — Factory still works, just without
 *     publishing events. This matches what Stock does and lets local dev
 *     run without RabbitMQ at all.
 *   - publishCrudEvent() never throws on transient errors; it logs and
 *     returns. The transaction that triggered it has already committed.
 *   - close() flushes on SIGINT/SIGTERM.
 *
 * Routing keys follow `{APP_NAME}.{table}.{action}`. For Factory we use
 *   factory.assembly_orders.completed   ← key business event
 *   factory.assembly_orders.cancelled
 *   factory.production_orders.inserted
 *   factory.production_orders.completed
 * Subscribers pattern-match e.g. `factory.assembly_orders.*` to catch them.
 *
 * The HTTP Management API fallback comes from Stock: amqplib's publish is
 * known to silently drop messages on Node 20 inside a Docker bridge network
 * (see Stock's rabbitmq.ts for the original comment). When RABBITMQ_HTTP_URL
 * is set we POST to /api/exchanges/{vhost}/{exchange}/publish instead.
 */

const RABBITMQ_URL = process.env.RABBITMQ_URL || '';
const RABBITMQ_HTTP_URL = process.env.RABBITMQ_HTTP_URL || '';
const RABBITMQ_VHOST = process.env.RABBITMQ_VHOST || '/';
const EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'platform.events';
const APP_NAME = process.env.APP_NAME || 'factory';

let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

export async function connect(): Promise<void> {
  if (!RABBITMQ_URL) {
    console.warn('[RabbitMQ] RABBITMQ_URL not set, skipping connection');
    return;
  }

  connection = await amqp.connect(RABBITMQ_URL);
  channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

  // Durable log queue capturing every event the factory app emits, kept
  // for debug / replay. Named `factory.events.log` so it doesn't collide
  // with Stock's own log queue.
  const logQueue = `${APP_NAME}.events.log`;
  await channel.assertQueue(logQueue, { durable: true });
  await channel.bindQueue(logQueue, EXCHANGE, `${APP_NAME}.#`);

  console.log(
    `[RabbitMQ] Connected to ${RABBITMQ_URL.replace(/:([^:@]+)@/, ':****@')}`,
  );
  console.log(`[RabbitMQ] Exchange: ${EXCHANGE} (topic, durable)`);
  console.log(`[RabbitMQ] Queue: ${logQueue} bound to ${APP_NAME}.#`);
  console.log(
    `[RabbitMQ] Publish mode: ${RABBITMQ_HTTP_URL ? 'HTTP Management API' : 'amqplib'}`,
  );

  connection.on('error', (err: Error) => {
    console.error('[RabbitMQ] Connection error:', err.message);
  });

  connection.on('close', () => {
    console.warn('[RabbitMQ] Connection closed');
    channel = null;
    connection = null;
  });
}

interface Actor {
  id: string;
  email: string;
}

interface PlatformEvent {
  id: string | number | null;
  table: string;
  action: string;
  data: Record<string, unknown>;
  timestamp: string;
  actor: Actor | null;
}

/**
 * Publish an event to the shared platform.events exchange.
 *
 * Despite the historical "Crud" name, `action` is free-form — Factory uses
 * `completed`, `cancelled`, `started` etc. alongside the CRUD verbs.
 *
 * Never throws. If the bus is down we log and move on; the caller's
 * business transaction already succeeded.
 */
export async function publishCrudEvent(
  table: string,
  action: string,
  data: Record<string, unknown>,
  actor: { id?: string; sub?: string; email?: string } | null = null,
): Promise<PlatformEvent | null> {
  if (!channel && !RABBITMQ_HTTP_URL) {
    console.warn(`[RabbitMQ] Channel not available: ${table}.${action}`);
    return null;
  }

  const event: PlatformEvent = {
    id: (data?.id as string | number | null) ?? null,
    table,
    action,
    data,
    timestamp: new Date().toISOString(),
    actor: actor
      ? { id: actor.sub || actor.id || '', email: actor.email || '' }
      : null,
  };

  const fullRoutingKey = `${APP_NAME}.${table}.${action}`;

  if (RABBITMQ_HTTP_URL) {
    try {
      const url = new URL(RABBITMQ_HTTP_URL);
      const auth = Buffer.from(`${url.username}:${url.password}`).toString('base64');
      const apiBase = `${url.protocol}//${url.host}`;
      const vhost = encodeURIComponent(RABBITMQ_VHOST);

      const res = await fetch(
        `${apiBase}/api/exchanges/${vhost}/${encodeURIComponent(EXCHANGE)}/publish`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
          body: JSON.stringify({
            properties: { delivery_mode: 2, content_type: 'application/json' },
            routing_key: fullRoutingKey,
            payload: JSON.stringify(event),
            payload_encoding: 'string',
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(
          `[RabbitMQ] HTTP publish failed: ${res.status} ${res.statusText} - ${body}`,
        );
      } else {
        const result = (await res.json()) as { routed: boolean };
        console.log(
          `[RabbitMQ] Published via HTTP: ${fullRoutingKey} (id=${event.id}, routed=${result.routed})`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[RabbitMQ] HTTP publish error: ${message}`);
    }
  } else if (channel) {
    channel.publish(
      EXCHANGE,
      fullRoutingKey,
      Buffer.from(JSON.stringify(event)),
      { persistent: true, contentType: 'application/json' },
    );
    console.log(`[RabbitMQ] Published: ${fullRoutingKey} (id=${event.id})`);
  }

  return event;
}

type MessageHandler = (
  event: Record<string, unknown>,
  routingKey: string,
) => Promise<void>;

export async function subscribe(
  pattern: string,
  handler: MessageHandler,
  queueName?: string,
): Promise<void> {
  if (!channel) {
    console.warn(`[RabbitMQ] Channel not available for subscribe: ${pattern}`);
    return;
  }

  const queue = queueName || `${APP_NAME}.${pattern}`;

  await channel.assertQueue(queue, { durable: true });
  await channel.bindQueue(queue, EXCHANGE, pattern);

  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const event = JSON.parse(msg.content.toString()) as Record<string, unknown>;
      const routingKey = msg.fields.routingKey;
      await handler(event, routingKey);
      channel!.ack(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[RabbitMQ] Error processing ${pattern}:`, message);
      // Send to DLQ via nack(false) — no requeue, prevents poison-pill loops.
      channel!.nack(msg, false, false);
    }
  });
}

export async function close(): Promise<void> {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    console.log('[RabbitMQ] Connection closed gracefully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[RabbitMQ] Error closing:', message);
  } finally {
    channel = null;
    connection = null;
  }
}

export default { connect, publishCrudEvent, subscribe, close };
