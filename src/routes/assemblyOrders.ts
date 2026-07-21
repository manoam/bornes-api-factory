import { Router } from 'express';
import * as ctrl from '../controllers/assemblyOrderController';
import * as productionCtrl from '../controllers/productionOrderController';

const router = Router();

router.get('/available-models', productionCtrl.availableModels as any);
router.get('/', ctrl.list as any);
router.post('/batch', ctrl.batchCreate as any);
router.get('/:id', ctrl.get as any);
router.get('/:id/checklist', ctrl.checklist as any);
router.get('/:id/history', ctrl.history as any);
router.patch('/:id', ctrl.update as any);
router.post('/:id/transition', ctrl.transition as any);
router.post('/:id/components', ctrl.addComponent as any);
router.delete('/:id/components/:componentId', ctrl.removeComponent as any);

// Upsert / delete par ProductCategory (mode "matrice" de la page assemblage).
// Au plus 1 composant par (assemblyOrder, productCategory).
router.put('/:id/categories/:productCategoryId', ctrl.upsertCategoryComponent as any);
router.delete('/:id/categories/:productCategoryId', ctrl.removeCategoryComponent as any);

export default router;
