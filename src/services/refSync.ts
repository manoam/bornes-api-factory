/**
 * RefSync — consomme les events `*.{base}.*` du bus et upsert dans la
 * table locale `{base}_ref`. Pattern Konitys partagé entre toutes les
 * apps.
 *
 * Cas typique pour Factory : table `users_ref` peuplée par les events
 * `hub.users.*` (ou tout autre publisher des users). Factory ne crée
 * jamais de users — il en lit une copie locale.
 *
 * Découverte automatique :
 *   - on liste toutes les tables `*_ref` du schema public
 *   - pour chaque table `<base>_ref`, on binde la queue sur `*.<base>.*`
 *   - une seule queue durable `<APP>.ref_sync` capture tous les bindings
 *     (la queue voit chaque event une seule fois grâce au routing
 *     topic — RabbitMQ fait la déduplication par routing key matching)
 *
 * On upsert UNIQUEMENT les colonnes présentes à la fois dans le payload
 * et dans la table — les champs inconnus sont ignorés (forward compat),
 * les colonnes locales absentes du payload restent NULL.
 */
import prisma from '../config/database';
import { initRabbitMQ, startConsumer, type ParsedMessage } from './rabbitmqHttp';

const APP = process.env.APP_NAME || 'factory';
const QUEUE = `${APP}.ref_sync`;

interface Subscription {
  refTable: string;
  source: string;
  pattern: string;
  queue: string;
}

let subscriptions: Subscription[] = [];

async function discoverRefTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name LIKE '%\\_ref' ESCAPE '\\'
     ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function columnsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    table,
  );
  return rows.map((r) => r.column_name);
}

function quoteIdent(name: string): string {
  // Postgres identifiers — pour les noms de tables/colonnes qu'on construit
  // par concaténation. On a déjà filtré par information_schema donc le risque
  // d'injection est nul, mais le quoting est correct par discipline.
  return `"${name.replace(/"/g, '""')}"`;
}

export async function startRefSync(): Promise<void> {
  const refs = await discoverRefTables();

  subscriptions = refs.map((t) => ({
    refTable: t,
    source: t.slice(0, -4),
    pattern: `*.${t.slice(0, -4)}.*`,
    queue: QUEUE,
  }));

  if (refs.length === 0) {
    console.log('[refSync] aucune table _ref détectée');
    return;
  }

  // Cache des colonnes par table — évite un SELECT à chaque message.
  const colsByTable: Record<string, string[]> = {};
  for (const t of refs) {
    colsByTable[t] = await columnsOf(t);
  }

  const bindings = subscriptions.map((s) => s.pattern);
  const ok = await initRabbitMQ({ queue: QUEUE, bindings });
  if (!ok) {
    console.warn('[refSync] RabbitMQ non disponible, sync désactivée');
    return;
  }

  startConsumer(QUEUE, async (evt: ParsedMessage) => {
    // Anti-boucle : on ignore les events qu'on aurait publiés nous-mêmes.
    if (evt.app === APP) return;

    const refTable = `${evt.table}_ref`;
    const cols = colsByTable[refTable];
    if (!cols) return;

    // Extraire le `data` du payload — `payload` peut être déjà l'objet
    // décodé, ou un objet { data: {...} } selon le publisher.
    const payload = evt.payload;
    if (typeof payload !== 'object' || payload === null) return;
    const data =
      'data' in payload && payload.data && typeof payload.data === 'object'
        ? (payload.data as Record<string, unknown>)
        : (payload as Record<string, unknown>);

    if (!data || typeof data !== 'object' || !('id' in data)) return;

    // Filtre : ne garde que les clés qui existent dans la table cible.
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (cols.includes(k)) row[k] = v;
    }
    if (!('id' in row)) return;

    if ((evt.action || '').toLowerCase() === 'deleted') {
      await prisma.$executeRawUnsafe(
        `DELETE FROM ${quoteIdent(refTable)} WHERE id=$1`,
        row.id,
      );
      return;
    }

    // UPSERT — INSERT ... ON CONFLICT (id) DO UPDATE
    const keys = Object.keys(row);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const colList = keys.map(quoteIdent).join(',');
    const updateClause = keys
      .filter((k) => k !== 'id')
      .map((k) => `${quoteIdent(k)}=EXCLUDED.${quoteIdent(k)}`)
      .join(',');

    const sql = updateClause
      ? `INSERT INTO ${quoteIdent(refTable)} (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updateClause}`
      : `INSERT INTO ${quoteIdent(refTable)} (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;

    await prisma.$executeRawUnsafe(sql, ...keys.map((k) => row[k]));
  });

  console.log(`[refSync] abonné aux _ref : ${refs.join(', ')}`);
}

export function getSubscriptions(): Subscription[] {
  return subscriptions;
}

export default { startRefSync, getSubscriptions };
