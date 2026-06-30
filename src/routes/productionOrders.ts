import { Router } from 'express';
import * as ctrl from '../controllers/productionOrderController';
import { requireRole } from '../middleware/auth';

const router = Router();

router.get('/', ctrl.list as any);
router.get('/:id', ctrl.get as any);
router.get('/:id/requirements', ctrl.requirements as any);
router.post('/', requireRole('admin', 'manager'), ctrl.create as any);
router.patch('/:id', requireRole('admin', 'manager'), ctrl.update as any);
router.post('/:id/plan', requireRole('admin', 'manager'), ctrl.plan as any);

export default router;
