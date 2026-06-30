import { Router } from 'express';
import * as ctrl from '../controllers/assemblyOrderController';

const router = Router();

router.get('/:id', ctrl.get as any);
router.patch('/:id', ctrl.update as any);
router.post('/:id/components', ctrl.addComponent as any);
router.delete('/:id/components/:componentId', ctrl.removeComponent as any);

export default router;
