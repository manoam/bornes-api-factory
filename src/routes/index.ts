import { Router } from 'express';
import productionOrderRoutes from './productionOrders';
import assemblyOrderRoutes from './assemblyOrders';
import { authenticate } from '../middleware/auth';

const router = Router();

// Public health check.
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// All other routes require Keycloak auth.
router.use(authenticate as any);

router.use('/production-orders', productionOrderRoutes);
router.use('/assembly-orders', assemblyOrderRoutes);

export default router;
