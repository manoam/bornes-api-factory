import axios from 'axios';

/**
 * Thin client over the Bornes (parc) app's HTTP API.
 *
 * Auth = a static `ws_token` query param shared with the Bornes team. We
 * keep it in BORNES_WS_TOKEN env var and pass it via interceptor — it
 * never reaches the browser.
 *
 * V1 only needs read-only access: list all bornes, build a Map keyed by
 * `numero_formated` (matches Factory's `internalNumber`), let callers
 * answer "does this internal number exist in the parc?".
 *
 * The Bornes app currently returns a flat array of ~850 rows in a single
 * call. That's small enough to cache in-memory with a short TTL (60s)
 * rather than hitting the API on every request to /produced-bornes.
 * Future: switch to RabbitMQ-fed read model once Bornes publishes events.
 */

const BORNES_API_URL = process.env.BORNES_API_URL || '';
const BORNES_WS_TOKEN = process.env.BORNES_WS_TOKEN || '';
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 60_000;

export interface BorneRow {
  id: number;
  numero: number;
  /** Internal Konitys numbering. Matches Factory's `internalNumber`. */
  numero_formated: string;
  numero_serie: string | null;
  statut: string;
  model_nom: string | null;
  gamme_nom: string | null;
  couleur_nom: string | null;
  etat_nom: string | null;
  parc_nom: string | null;
  localisation: string | null;
  adresse: string | null;
  ville: string | null;
  client_enseigne: string | null;
  antenne_ville: string | null;
  sortie_atelier: string | null;
  updated_at: string | null;
}

interface CacheSlot {
  fetchedAt: number;
  byInternal: Map<string, BorneRow>;
  count: number;
}

let cache: CacheSlot | null = null;
let inflight: Promise<CacheSlot> | null = null;

function client() {
  return axios.create({
    baseURL: BORNES_API_URL,
    timeout: TIMEOUT_MS,
    // ws_token is appended at call time so we can log a missing token clearly
    // instead of letting axios serialize an empty value silently.
  });
}

async function refresh(): Promise<CacheSlot> {
  if (!BORNES_API_URL || !BORNES_WS_TOKEN) {
    throw new Error('Bornes API non configurée (BORNES_API_URL / BORNES_WS_TOKEN)');
  }
  const res = await client().get<BorneRow[]>('/ws/bornes/all', {
    params: { ws_token: BORNES_WS_TOKEN },
  });
  const rows = Array.isArray(res.data) ? res.data : [];
  const byInternal = new Map<string, BorneRow>();
  for (const b of rows) {
    if (b.numero_formated) byInternal.set(b.numero_formated.trim(), b);
  }
  const slot: CacheSlot = {
    fetchedAt: Date.now(),
    byInternal,
    count: rows.length,
  };
  cache = slot;
  return slot;
}

/**
 * Get the cached snapshot, refreshing it lazily when older than TTL.
 *
 * Two concurrent callers don't both trigger a refresh: the inflight promise
 * is shared. On fetch error we keep returning the stale snapshot (still
 * better than crashing the page) but propagate the error if we have no
 * snapshot at all yet.
 */
export async function getBornesSnapshot(force = false): Promise<CacheSlot> {
  const now = Date.now();
  const stale = !cache || now - cache.fetchedAt > CACHE_TTL_MS;
  if (!force && !stale && cache) return cache;
  if (inflight) return inflight;
  inflight = refresh()
    .catch((err) => {
      // Garde le cache stale s'il existait — log et propage seulement si rien.
      if (cache) {
        console.warn('[BornesClient] refresh failed, using stale cache:', err.message);
        return cache;
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function isConfigured(): boolean {
  return !!(BORNES_API_URL && BORNES_WS_TOKEN);
}
