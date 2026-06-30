import { Router } from 'express';
import * as ctrl from '../controllers/productionOrderController';

const router = Router();

// MVP: any authenticated user can manage production orders. The role-based
// guard (requireRole('admin', 'manager')) was creating a chicken-and-egg
// problem during onboarding — operators couldn't even create their first OF.
//
// V1.1: once the Konitys permissions system is wired in (data-perm + the
// /adminpanel/permissions-schema endpoint), bring back per-action gating via
// `requirePerm('factory', 'production_orders.create')` etc.
router.get('/', ctrl.list as any);
router.get('/:id', ctrl.get as any);
router.get('/:id/requirements', ctrl.requirements as any);
router.post('/', ctrl.create as any);
router.patch('/:id', ctrl.update as any);
router.post('/:id/plan', ctrl.plan as any);

export default router;
