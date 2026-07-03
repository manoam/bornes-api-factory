import { Router } from 'express';
import * as ctrl from '../controllers/componentTimelineController';

const router = Router();

router.get('/timeline', ctrl.getTimeline as any);

export default router;
