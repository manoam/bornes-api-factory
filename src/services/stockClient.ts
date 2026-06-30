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
}

export interface StockAssemblyTypeItem {
  id: string;
  productId: string;
  quantity: number;
  product: { reference: string; description: string | null };
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
   * Returns the assembly type by name (e.g. "Borne Kalifun") with its
   * full BOM. Used by Factory to compute the component requirements for
   * a production order.
   */
  async getAssemblyTypeByName(name: string): Promise<StockAssemblyType | null> {
    const all = await wrap<StockAssemblyType[]>(
      makeClient(this.token).get(`/assembly-types`),
    );
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
