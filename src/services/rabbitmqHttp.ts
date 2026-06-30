/**
 * RabbitMQ via HTTP Management API (port 15672) — JAMAIS amqplib.
 *
 * Pourquoi : sur l'infra Coolify (Scaleway, réseau bridge Docker), `amqplib`
 * (AMQP port 5672) ne fonctionne pas de façon fiable. Tout passe par
 * l'API HTTP Management.
 *
 * Ce module fait :
 *   - init : vérifie connexion + assert exchange + assert queue + bindings
 *   - publish : POST /exchanges/{vhost}/{exchange}/publish
 *   - consume : polling POST /queues/{vhost}/{queue}/get à un intervalle
 *   - selfTest : publish + relit la même payload sur une queue éphémère
 *
 * Calque conforme au guide `guide-consume-users-ref-rabbitmq-http.md`
 * (transmis par l'équipe plateforme).
 */

const ENABLED = String(process.env.RABBITMQ_ENABLED ?? 'true') !== 'false';
const URL = process.env.RABBITMQ_URL || '';
const EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'konitysevents';
const APP_NAME = process.env.APP_NAME || 'factory';
const MGMT_PORT = process.env.RABBITMQ_MGMT_PORT || '15672';

type Status = 'disconnected' | 'connecting' | 'connected' | 'disabled' | 'error';

let status: Status = 'disconnected';
let lastError: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

interface MgmtConfig {
  baseUrl: string;
  auth: string;
  vhost: string;
}

// Le URL AMQP ne sert qu'à parser host/user/pass/vhost. Le transport réel
// est HTTP sur RABBITMQ_MGMT_PORT.
function getMgmt(): MgmtConfig {
  const host = (URL.match(/@([^:/?]+)/) || [])[1] || 'rabbitmq';
  const cred = URL.match(/\/\/([^:]+):([^@]+)@/) || [];
  const user = cred[1] || '';
  const pass = cred[2] || '';
  const vhost = decodeURIComponent((URL.match(/\/([^/?]+)(\?|$)/) || [])[1] || 'plateform');
  return {
    baseUrl: `http://${host}:${MGMT_PORT}/api`,
    auth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    vhost: encodeURIComponent(vhost),
  };
}

async function mgmtGet(path: string): Promise<any> {
  const m = getMgmt();
  try {
    const res = await fetch(`${m.baseUrl}${path}`, {
      headers: { Authorization: m.auth },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { error: `${res.status} ${res.statusText}` };
    return res.json();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function mgmtPut(path: string, body: unknown): Promise<boolean> {
  const m = getMgmt();
  try {
    const res = await fetch(`${m.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: m.auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function mgmtPost(path: string, body: unknown): Promise<Response> {
  const m = getMgmt();
  return fetch(`${m.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: m.auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

interface InitOpts {
  queue?: string;
  bindings?: string[];
}

/**
 * Vérifie la connexion + assert exchange.
 * Si `queue` est fourni, assert la queue durable + applique les bindings.
 */
export async function initRabbitMQ(opts: InitOpts = {}): Promise<boolean> {
  if (!ENABLED || !URL) {
    status = 'disabled';
    console.warn('[RabbitMQ] disabled (RABBITMQ_ENABLED=false ou RABBITMQ_URL vide)');
    return false;
  }
  status = 'connecting';
  const m = getMgmt();

  const ov = await mgmtGet('/overview');
  if (ov.error) {
    status = 'error';
    lastError = ov.error;
    console.error('[RabbitMQ] init failed:', ov.error);
    return false;
  }

  // Exchange topic durable, partagé entre toutes les apps Konitys.
  await mgmtPut(`/exchanges/${m.vhost}/${encodeURIComponent(EXCHANGE)}`, {
    type: 'topic',
    durable: true,
    auto_delete: false,
  });

  if (opts.queue) {
    await mgmtPut(`/queues/${m.vhost}/${encodeURIComponent(opts.queue)}`, {
      durable: true,
      auto_delete: false,
    });
    const bindings = opts.bindings && opts.bindings.length > 0 ? opts.bindings : ['#'];
    for (const rk of bindings) {
      await mgmtPost(
        `/bindings/${m.vhost}/e/${encodeURIComponent(EXCHANGE)}/q/${encodeURIComponent(opts.queue)}`,
        { routing_key: rk },
      );
    }
  }

  status = 'connected';
  lastError = null;
  console.log(`[RabbitMQ] connected (HTTP API), exchange=${EXCHANGE}, app=${APP_NAME}`);
  return true;
}

interface ActorLike {
  id?: string | number;
  sub?: string;
  user_id?: string | number;
  email?: string;
}

/**
 * Publie un event sur l'exchange partagé.
 *
 * Routing key : `{APP_NAME}.{table}.{action}`
 * Payload : { id, table, action, app, data, timestamp, actor }
 *
 * Le champ `app` est obligatoire — c'est lui que les consumers utilisent
 * pour l'anti-boucle (`if evt.app === APP_NAME, ignore`).
 *
 * Ne throw jamais : si le bus est down, on log et on continue. La
 * transaction métier qui a déclenché ce publish a déjà commit.
 */
export async function publishEvent(
  table: string,
  action: string,
  data: Record<string, unknown> = {},
  actor: ActorLike | null = null,
): Promise<boolean> {
  if (status !== 'connected') {
    console.warn(
      `[RabbitMQ] DROP ${APP_NAME}.${table}.${action} (status=${status})`,
    );
    return false;
  }
  const m = getMgmt();
  const routingKey = `${APP_NAME}.${table}.${action}`;
  const payload = {
    id: (data?.id as string | number | null) ?? null,
    table,
    action,
    app: APP_NAME,
    data,
    timestamp: new Date().toISOString(),
    actor: actor
      ? {
          id: actor.id ?? actor.sub ?? actor.user_id ?? null,
          email: actor.email ?? null,
        }
      : null,
  };

  try {
    const res = await mgmtPost(
      `/exchanges/${m.vhost}/${encodeURIComponent(EXCHANGE)}/publish`,
      {
        routing_key: routingKey,
        payload: JSON.stringify(payload),
        payload_encoding: 'string',
        properties: {
          delivery_mode: 2,
          content_type: 'application/json',
          app_id: APP_NAME,
        },
      },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { routed: boolean };
    return !!body.routed;
  } catch (err) {
    console.error(
      `[RabbitMQ] publish error ${routingKey}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

export interface ParsedMessage {
  routingKey: string;
  app: string;
  table: string;
  action: string;
  payload: Record<string, unknown> | string;
}

interface RawMessage {
  routing_key?: string;
  payload?: string;
}

function parseMessage(msg: RawMessage): ParsedMessage {
  const rk = msg.routing_key || '';
  let payload: Record<string, unknown> | string = msg.payload || '';
  try {
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch {
    /* texte brut */
  }
  const parts = rk.split('.');
  return {
    routingKey: rk,
    app: parts[0] || '',
    table: parts[1] || '',
    action: parts.slice(2).join('.'),
    payload,
  };
}

interface ConsumerOpts {
  interval?: number;
  batch?: number;
}

/**
 * Démarre un polling HTTP qui lit en continu une queue.
 *
 * Ackmode = `ack_requeue_false` : on confirme la lecture; si on jette une
 * exception dans le handler, le message est PERDU (pas requeue). C'est OK
 * pour notre cas — les events sont idempotents (upsert) et un message
 * raté sera de toute façon corrigé par le prochain update du même user.
 *
 * Si le handler doit pouvoir échouer proprement plus tard, on basculera
 * sur `ack_requeue_true` et on gérera explicitement les DLQ.
 */
export function startConsumer(
  queue: string,
  handler: (msg: ParsedMessage) => Promise<void> | void,
  opts: ConsumerOpts = {},
): void {
  if (pollTimer) return;
  const interval = opts.interval ?? 3000;
  const batch = opts.batch ?? 20;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const m = getMgmt();
      const res = await mgmtPost(
        `/queues/${m.vhost}/${encodeURIComponent(queue)}/get`,
        {
          count: batch,
          ackmode: 'ack_requeue_false',
          encoding: 'auto',
        },
      );
      if (res.ok) {
        const msgs = (await res.json()) as RawMessage[];
        for (const msg of msgs) {
          try {
            await handler(parseMessage(msg));
          } catch (err) {
            // Ne bloque pas le polling sur une erreur d'un message
            console.error(
              `[RabbitMQ] handler error queue=${queue}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    } catch (err) {
      // Retry au prochain tick — typiquement une perte momentanée de
      // connexion. Surfacer en debug seulement, sinon trop de bruit.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[RabbitMQ] poll error queue=${queue}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } finally {
      polling = false;
    }
  };

  pollTimer = setInterval(poll, interval);
  // Premier tick immédiat — évite d'attendre `interval` ms au boot.
  void poll();
}

export function stopConsumer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getStatus() {
  return {
    connected: status === 'connected',
    status,
    error: lastError,
    exchange: EXCHANGE,
    app: APP_NAME,
    mode: 'http-api' as const,
  };
}

/**
 * Self-test e2e : publie une sonde sur une queue temporaire et la relit.
 * Utile pour /api/health ou pour debug en démarrage.
 */
export async function selfTest(): Promise<{
  ok: boolean;
  routed?: boolean;
  consumed?: boolean;
  reason?: string;
}> {
  if (!ENABLED || !URL) return { ok: false, reason: 'disabled' };
  const m = getMgmt();
  const probe = `${APP_NAME}.__probe__`;
  const nonce = `probe-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  try {
    await mgmtPut(`/exchanges/${m.vhost}/${encodeURIComponent(EXCHANGE)}`, {
      type: 'topic',
      durable: true,
      auto_delete: false,
    });
    await mgmtPut(`/queues/${m.vhost}/${encodeURIComponent(probe)}`, {
      durable: false,
      auto_delete: true,
    });
    await mgmtPost(
      `/bindings/${m.vhost}/e/${encodeURIComponent(EXCHANGE)}/q/${encodeURIComponent(probe)}`,
      { routing_key: `${APP_NAME}.__probe__.#` },
    );
    const pub = await mgmtPost(
      `/exchanges/${m.vhost}/${encodeURIComponent(EXCHANGE)}/publish`,
      {
        routing_key: `${APP_NAME}.__probe__.ping`,
        payload: JSON.stringify({ nonce }),
        payload_encoding: 'string',
        properties: { content_type: 'application/json' },
      },
    );
    const pubBody = pub.ok ? ((await pub.json()) as { routed: boolean }) : null;
    await new Promise((r) => setTimeout(r, 600));
    let consumed = false;
    const get = await mgmtPost(
      `/queues/${m.vhost}/${encodeURIComponent(probe)}/get`,
      { count: 10, ackmode: 'ack_requeue_false', encoding: 'auto' },
    );
    if (get.ok) {
      const msgs = (await get.json()) as RawMessage[];
      consumed = msgs.some((x) => String(x.payload).includes(nonce));
    }
    // Cleanup best-effort
    await fetch(`${m.baseUrl}/queues/${m.vhost}/${encodeURIComponent(probe)}`, {
      method: 'DELETE',
      headers: { Authorization: m.auth },
    }).catch(() => {});
    return {
      ok: !!(pub.ok && pubBody && pubBody.routed && consumed),
      routed: !!(pubBody && pubBody.routed),
      consumed,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export default {
  initRabbitMQ,
  publishEvent,
  startConsumer,
  stopConsumer,
  getStatus,
  selfTest,
};
