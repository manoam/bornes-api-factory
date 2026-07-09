import {
  getBornesSnapshot,
  isConfigured as isBornesConfigured,
} from './bornesClient';

/**
 * Enrichissement de rows chantier (Repair / Refurbishment / Disassembly)
 * avec les infos parc de l'API Bornes.
 *
 * Un seul appel `getBornesSnapshot()` par requête HTTP entrante (le snapshot
 * est caché 60s côté service, donc quasi-gratuit en pratique), puis on
 * pioche par `numero_formated` dans la Map en O(1) pour chaque row.
 *
 * Si l'API Bornes n'est pas configurée ou renvoie une erreur : on renvoie
 * les rows tels quels avec des champs `borne*` à null. Ne throw jamais —
 * la liste doit rester utilisable même si Bornes est down.
 */

export interface BorneEnrichment {
  borneGamme: string | null;
  borneParc: string | null;
  borneEnseigne: string | null;
}

const EMPTY: BorneEnrichment = {
  borneGamme: null,
  borneParc: null,
  borneEnseigne: null,
};

export async function enrichRowsWithBornes<
  T extends { borneInternalNumber: string },
>(rows: T[]): Promise<(T & BorneEnrichment)[]> {
  if (!isBornesConfigured() || rows.length === 0) {
    return rows.map((r) => ({ ...r, ...EMPTY }));
  }
  try {
    const snap = await getBornesSnapshot();
    return rows.map((r) => {
      const b = snap.byInternal.get(r.borneInternalNumber);
      if (!b) return { ...r, ...EMPTY };
      return {
        ...r,
        borneGamme: b.gamme_nom,
        borneParc: b.parc_nom,
        borneEnseigne: b.client_enseigne,
      };
    });
  } catch {
    // L'appel a échoué (timeout, 5xx). On renvoie les rows sans enrichir.
    return rows.map((r) => ({ ...r, ...EMPTY }));
  }
}

/**
 * Variante pour les assemblies qui ont `internalNumber` (pas
 * `borneInternalNumber`). L'assembly_orders utilise ce nom là.
 */
export async function enrichRowsWithBornesByInternal<
  T extends { internalNumber: string | null },
>(rows: T[]): Promise<(T & BorneEnrichment)[]> {
  if (!isBornesConfigured() || rows.length === 0) {
    return rows.map((r) => ({ ...r, ...EMPTY }));
  }
  try {
    const snap = await getBornesSnapshot();
    return rows.map((r) => {
      const b = r.internalNumber ? snap.byInternal.get(r.internalNumber) : null;
      if (!b) return { ...r, ...EMPTY };
      return {
        ...r,
        borneGamme: b.gamme_nom,
        borneParc: b.parc_nom,
        borneEnseigne: b.client_enseigne,
      };
    });
  } catch {
    return rows.map((r) => ({ ...r, ...EMPTY }));
  }
}
