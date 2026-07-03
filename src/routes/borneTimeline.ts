import { Router } from 'express';
import * as ctrl from '../controllers/borneTimelineController';

const router = Router();

router.get('/:internal/timeline', ctrl.getBorneTimeline as any);

export default router;
