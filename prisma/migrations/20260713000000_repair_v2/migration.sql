-- V2 Réparation : ON_HOLD, priorité, kind/partState, cloture formelle, pieces jointes.
-- Décision : données de test uniquement, drop-recreate direct des colonnes/enums modifiés.

-- ─── 1. Nettoyer les lignes composants (structure trop différente pour être migrée)
DELETE FROM "repair_components";

-- ─── 2. Drop anciens enums (plus référencés une fois la colonne action supprimée)
ALTER TABLE "repair_components" DROP COLUMN IF EXISTS "action";
ALTER TABLE "repair_components" DROP COLUMN IF EXISTS "disposition";
ALTER TABLE "repair_components" DROP COLUMN IF EXISTS "stockMovementId";

DROP TYPE IF EXISTS "RepairComponentAction";
DROP TYPE IF EXISTS "RepairComponentDisposition";

-- ─── 3. Nouveaux enums V2
CREATE TYPE "RepairPriority"          AS ENUM ('NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "RepairInterventionKind"  AS ENUM ('REPLACED', 'CHECKED', 'DIAGNOSED');
CREATE TYPE "RepairPartState"         AS ENUM ('OK', 'DEFECTIVE', 'TO_CHECK', 'SUSPECT');
CREATE TYPE "RepairFinalResult"       AS ENUM ('RESOLVED', 'NOT_REPRODUCED', 'BEYOND_REPAIR', 'ESCALATED');

-- ─── 4. Ajouter ON_HOLD à RepairOrderStatus (avant TESTING pour cohérence visuelle)
ALTER TYPE "RepairOrderStatus" ADD VALUE 'ON_HOLD' BEFORE 'TESTING';

-- ─── 5. Enrichir repair_orders
ALTER TABLE "repair_orders"
  ADD COLUMN "priority"        "RepairPriority"     NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "diagnosisSource" TEXT,
  ADD COLUMN "onHoldReason"    TEXT,
  ADD COLUMN "report"          TEXT,
  ADD COLUMN "finalResult"     "RepairFinalResult";

CREATE INDEX "repair_orders_priority_idx" ON "repair_orders"("priority");

-- ─── 6. Enrichir repair_components (nouvelles colonnes)
ALTER TABLE "repair_components"
  ADD COLUMN "kind"             "RepairInterventionKind" NOT NULL,
  ADD COLUMN "partState"        "RepairPartState"        NOT NULL DEFAULT 'OK',
  ADD COLUMN "comment"          TEXT,
  ADD COLUMN "stockMovementIds" JSONB;

-- ─── 7. Nouvelle table repair_attachments
CREATE TABLE "repair_attachments" (
  "id"             TEXT NOT NULL,
  "repairOrderId"  TEXT NOT NULL,
  "filename"       TEXT NOT NULL,
  "url"            TEXT NOT NULL,
  "mimeType"       TEXT NOT NULL,
  "sizeBytes"      INTEGER NOT NULL,
  "uploadedById"   TEXT NOT NULL,
  "uploadedByName" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "repair_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_attachments_repairOrderId_idx" ON "repair_attachments"("repairOrderId");

ALTER TABLE "repair_attachments"
  ADD CONSTRAINT "repair_attachments_repairOrderId_fkey"
  FOREIGN KEY ("repairOrderId") REFERENCES "repair_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
