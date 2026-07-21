import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { stockClientFor, StockPartType } from '../services/stockClient';

/**
 * Proxy vers Stock pour peupler le panel "Ajouter un composant" de la
 * page assemblage Factory. Trois endpoints :
 *
 *   GET /catalog/product-categories?partType=EQUIPMENT
 *   GET /catalog/products?productCategoryId=<uuid>
 *   GET /catalog/products/:productId/serial-items?status=IN_STOCK
 *
 * Passe le token utilisateur verbatim à Stock (permissions préservées).
 */

const VALID_PART_TYPES: StockPartType[] = ['EQUIPMENT', 'PROTECTION', 'ACCESSORY'];

export async function listProductCategories(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const partTypeRaw = typeof req.query.partType === 'string' ? req.query.partType : undefined;
    const partType = partTypeRaw && VALID_PART_TYPES.includes(partTypeRaw as StockPartType)
      ? (partTypeRaw as StockPartType)
      : undefined;
    const stock = stockClientFor(req.user.rawToken);
    const cats = await stock.getProductCategories({ partType, activeOnly: true });
    res.json({ success: true, data: cats });
  } catch (err) {
    next(err);
  }
}

export async function listProductsByCategory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const productCategoryId = typeof req.query.productCategoryId === 'string'
      ? req.query.productCategoryId
      : undefined;
    if (!productCategoryId) {
      return res.status(400).json({
        success: false,
        error: 'productCategoryId requis',
      });
    }
    const stock = stockClientFor(req.user.rawToken);
    const products = await stock.getProductsByCategory(productCategoryId);
    res.json({ success: true, data: products });
  } catch (err) {
    next(err);
  }
}

export async function listSerialItems(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const productId = String(req.params.productId);
    // Par défaut on ne montre que les SN en stock (disponibles).
    const statusParam = typeof req.query.status === 'string' ? req.query.status : 'IN_STOCK';
    const status = ['IN_STOCK', 'OUT', 'IN_REPAIR', 'SCRAPPED', 'LOST'].includes(statusParam)
      ? (statusParam as 'IN_STOCK' | 'OUT' | 'IN_REPAIR' | 'SCRAPPED' | 'LOST')
      : 'IN_STOCK';
    const stock = stockClientFor(req.user.rawToken);
    const items = await stock.getSerialItems(productId, { status });
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
}
