import axios, { AxiosInstance } from 'axios';
import { AppError } from '../middleware/errorHandler';

/**
 * Thin HTTP client over the Stock API. V1 = synchronous calls; V2 will
 * swap most reads for RabbitMQ-fed local caches (`stock.product.*`).
 *
 * The user's Keycloak token is forwarded verbatim so Stock can authenticate
 * the request as if the user were hitting it directly. We deliberately
 * don't issue service tokens: any data Factory wants to read, the user
 * must already be allowed to read on the Stock side.
 *
 * A short timeout (4s) keeps Factory responsive when Stock is slow or
 * down — the controller surfaces a 502 to the UI instead of hanging.
 */
const STOCK_API_URL = process.env.STOCK_API_URL || 'http://localhost:3001/api';
const TIMEOUT_MS = 4000;

export interface StockProduct {
  id: string;
  reference: string;
  description: string | null;
  imageUrl: string | null;
  hasSerialNumber: boolean;
  /** Categorie principale (Imprimante / PC / ...) — sert au mapping
   *  card cote reconditionnement. Null si le produit n'est pas encore
   *  tage cote Stock. */
  productCategoryId: string | null;
}

/**
 * Type de piece (orthogonal a PartCategory qui decrit la localisation).
 * Utilise cote Factory pour grouper la checklist d'assemblage.
 */
export type StockPartType = 'EQUIPMENT' | 'PROTECTION' | 'ACCESSORY';

export interface StockAssemblyTypeItem {
  id: string;
  productId: string;
  quantity: number;
  /**
   * Le product embarque partType (nature de la piece : Equipement / Protection
   * / Accessoire). Null si l'admin Stock n'a pas encore tague le produit —
   * dans ce cas Factory cache la ligne dans la checklist.
   */
  product: {
    reference: string;
    description: string | null;
    partType: StockPartType | null;
  };
  /**
   * partCategory reste dispo (localisation : Tete/Pied/Socle) mais n'est plus
   * utilise cote Factory pour grouper la checklist. On garde le champ pour
   * eviter de casser d'autres usages potentiels.
   */
  partCategory: { id: string; name: string } | null;
}

export interface StockAssemblyType {
  id: string;
  name: string;
  description: string | null;
  items: StockAssemblyTypeItem[];
}

export interface StockRow {
  productId: string;
  siteId: string;
  quantityNew: number;
  quantityUsed: number;
}

export interface StockSite {
  id: string;
  name: string;
  type: 'STORAGE' | 'EXIT';
  isActive: boolean;
}

export interface StockProductCategory {
  id: string;
  name: string;
  codeReference: string;
  partType: StockPartType | null;
  isActive: boolean;
  displayOrder: number;
}

export interface StockSerialItem {
  id: string;
  serialNumber: string | null;
  status: 'IN_STOCK' | 'OUT' | 'IN_REPAIR' | 'SCRAPPED' | 'LOST';
  condition: 'NEW' | 'USED';
  siteId: string | null;
  borneNumber: string | null;
}

/**
 * Product enrichi avec les infos nécessaires au panel d'ajout Factory.
 * Reprend StockProduct + les champs de composition (name, brand, model).
 */
export interface StockProductLite {
  id: string;
  reference: string;
  name: string | null;
  description: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  imageUrl: string | null;
  hasSerialNumber: boolean;
  productCategoryId: string | null;
}

function makeClient(token: string): AxiosInstance {
  return axios.create({
    baseURL: STOCK_API_URL,
    timeout: TIMEOUT_MS,
    headers: { Authorization: `Bearer ${token}` },
  });
}

function wrap<T>(p: Promise<{ data: { data?: T } }>): Promise<T> {
  return p
    .then((res) => {
      const payload = res.data?.data as T | undefined;
      if (payload === undefined) {
        throw new AppError('Réponse Stock vide ou invalide', 502);
      }
      return payload;
    })
    .catch((err) => {
      if (err instanceof AppError) throw err;
      const status = err.response?.status;
      const message = err.response?.data?.error || err.message || 'Erreur Stock';
      throw new AppError(`Stock API: ${message}`, status >= 400 && status < 500 ? status : 502);
    });
}

export class StockClient {
  constructor(private token: string) {}

  getProduct(id: string): Promise<StockProduct> {
    return wrap(makeClient(this.token).get(`/products/${id}`));
  }

  searchProducts(q: string): Promise<StockProduct[]> {
    return wrap(
      makeClient(this.token).get(`/products?search=${encodeURIComponent(q)}&limit=30`),
    );
  }

  /**
   * Returns the full list of assembly types (BOMs) defined in Stock. Used
   * to populate the "Modèle" dropdown when creating a ProductionOrder.
   */
  getAssemblyTypes(): Promise<StockAssemblyType[]> {
    return wrap(makeClient(this.token).get(`/assembly-types`));
  }

  /**
   * Returns the assembly type by name (e.g. "Borne Kalifun") with its
   * full BOM. Used by Factory to compute the component requirements for
   * a production order.
   */
  async getAssemblyTypeByName(name: string): Promise<StockAssemblyType | null> {
    const all = await this.getAssemblyTypes();
    return all.find((at) => at.name === name) || null;
  }

  /**
   * Returns the raw stock matrix (productId × siteId × condition). Factory
   * sums quantityNew + quantityUsed for "available" per product.
   */
  getStocks(): Promise<StockRow[]> {
    return wrap(makeClient(this.token).get(`/stocks`));
  }

  getSites(): Promise<StockSite[]> {
    return wrap(makeClient(this.token).get(`/sites`));
  }

  /**
   * Find the "atelier" site to source assembly components from. We prefer
   * a site whose name starts with "Atelier" (case-insensitive), else fall
   * back to the first active STORAGE site. Throws when no candidate exists.
   */
  async getAtelierSite(): Promise<StockSite> {
    const sites = await this.getSites();
    const atelier = sites.find(
      (s) => s.isActive && /^atelier/i.test(s.name),
    );
    if (atelier) return atelier;
    const fallback = sites.find((s) => s.isActive && s.type === 'STORAGE');
    if (!fallback) {
      throw new AppError(
        "Aucun site STORAGE actif côté Stock — impossible de sourcer l'assemblage",
        500,
      );
    }
    return fallback;
  }

  /**
   * Asks Stock to create a movement. We don't do this ourselves — Stock is
   * the source of truth for movements and quantities.
   *
   * Used when an assembly_order is completed: Factory issues OUT movements
   * for every installed component.
   */
  /**
   * Liste les catégories principales de produit (Imprimante, PC, Écran,
   * ...), filtrable par partType (Équipement / Protection / Accessoire).
   * Utilisé par le panel d'ajout de composants Factory.
   */
  getProductCategories(opts?: {
    partType?: StockPartType;
    activeOnly?: boolean;
  }): Promise<StockProductCategory[]> {
    const params: string[] = [];
    if (opts?.partType) params.push(`partType=${opts.partType}`);
    if (opts?.activeOnly) params.push('isActive=true');
    const qs = params.length ? `?${params.join('&')}` : '';
    return wrap(makeClient(this.token).get(`/product-categories${qs}`));
  }

  /**
   * Liste les produits filtrés par catégorie. Le résultat est extrait de
   * la réponse paginée standard (`{data: [...], pagination: {...}}`).
   */
  async getProductsByCategory(productCategoryId: string): Promise<StockProductLite[]> {
    // Response shape: { success, data: [...], pagination }. wrap() renvoie data.
    const res = await makeClient(this.token).get(
      `/products?productCategoryId=${productCategoryId}&limit=500&sortBy=reference`,
    );
    return (res.data?.data ?? []) as StockProductLite[];
  }

  /**
   * Liste les numéros de série d'un produit, filtrables par statut
   * (`IN_STOCK` pour ne montrer que les SN dispos à l'installation).
   */
  getSerialItems(
    productId: string,
    opts?: { status?: StockSerialItem['status'] },
  ): Promise<StockSerialItem[]> {
    const qs = opts?.status ? `?status=${opts.status}` : '';
    return wrap(makeClient(this.token).get(`/products/${productId}/serial-items${qs}`));
  }

  createMovement(payload: {
    productId: string;
    type: 'IN' | 'OUT' | 'TRANSFER';
    quantity: number;
    condition: 'NEW' | 'USED';
    movementDate: string;
    sourceSiteId?: string;
    targetSiteId?: string;
    comment?: string;
    serialNumbers?: string[];
  }): Promise<{ id: string }> {
    return wrap(makeClient(this.token).post(`/movements`, payload));
  }
}

export function stockClientFor(token: string): StockClient {
  return new StockClient(token);
}
