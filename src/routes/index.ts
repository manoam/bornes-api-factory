import { Router } from 'express';
import productionOrderRoutes from './productionOrders';
import assemblyOrderRoutes from './assemblyOrders';
import producedBorneRoutes from './producedBornes';
import userRefRoutes from './userRef';
import dashboardRoutes from './dashboard';
import repairOrderRoutes from './repairOrders';
import disassemblyRoutes from './disassemblies';
import refurbishmentRoutes from './refurbishments';
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
router.use('/produced-bornes', producedBorneRoutes);
router.use('/users-ref', userRefRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/repair-orders', repairOrderRoutes);
router.use('/disassemblies', disassemblyRoutes);
router.use('/refurbishments', refurbishmentRoutes);

export default router;
