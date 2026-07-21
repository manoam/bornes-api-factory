import { Router } from 'express';
import * as ctrl from '../controllers/stockCatalogController';

const router = Router();

router.get('/product-categories', ctrl.listProductCategories as any);
router.get('/products', ctrl.listProductsByCategory as any);
router.get('/products/:productId/serial-items', ctrl.listSerialItems as any);

export default router;
