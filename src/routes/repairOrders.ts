import { Router } from 'express';
import * as ctrl from '../controllers/repairOrderController';
import { repairAttachmentsMulter } from '../config/uploads';

const router = Router();

router.get('/', ctrl.list as any);
router.get('/:id', ctrl.get as any);
router.get('/:id/borne-info', ctrl.borneInfo as any);
router.get('/:id/checklist', ctrl.checklist as any);
router.get('/:id/history', ctrl.history as any);
router.post('/', ctrl.create as any);
router.patch('/:id', ctrl.update as any);
router.post('/:id/transition', ctrl.transition as any);
router.post('/:id/close', ctrl.close as any);
router.post('/:id/components', ctrl.addComponent as any);
router.delete('/:id/components/:componentId', ctrl.removeComponent as any);
router.post(
  '/:id/attachments',
  repairAttachmentsMulter().single('file'),
  ctrl.uploadAttachment as any,
);
router.delete('/:id/attachments/:attachmentId', ctrl.deleteAttachment as any);

export default router;
