import { Router } from 'express';
import * as ctrl from '../controllers/userRefController';

const router = Router();

router.get('/', ctrl.list as any);
router.get('/:id', ctrl.get as any);

export default router;
