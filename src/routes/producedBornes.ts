import { Router } from 'express';
import * as ctrl from '../controllers/producedBorneController';

const router = Router();

router.get('/', ctrl.list as any);
router.get('/:internalNumber/parc', ctrl.getParcInfo as any);

export default router;
