import { Router } from 'express';
import * as ctrl from '../controllers/dashboardController';

const router = Router();

router.get('/stats', ctrl.stats as any);

export default router;
