-- Ordres de reparation Factory (V2 chantier metier).

CREATE TYPE "RepairOrderStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "RepairComponentAction" AS ENUM ('REMOVED', 'INSTALLED');
CREATE TYPE "RepairComponentDisposition" AS ENUM ('TO_TEST', 'SCRAP', 'STOCK_USED');

CREATE TABLE "repair_orders" (
  "id"                  TEXT NOT NULL,
  "borneInternalNumber" TEXT NOT NULL,
  "sourceApp"           TEXT NOT NULL DEFAULT 'unknown',
  "status"              "RepairOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "diagnosis"           TEXT,
  "operatorId"          TEXT,
  "operatorName"        TEXT,
  "notes"               TEXT,
  "qualityChecks"       JSONB,
  "startedAt"           TIMESTAMP(3),
  "completedAt"         TIMESTAMP(3),
  "createdById"         TEXT NOT NULL,
  "createdByName"       TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "repair_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_orders_borneInternalNumber_idx" ON "repair_orders"("borneInternalNumber");
CREATE INDEX "repair_orders_status_idx" ON "repair_orders"("status");
CREATE INDEX "repair_orders_createdAt_idx" ON "repair_orders"("createdAt");

CREATE TABLE "repair_components" (
  "id"               TEXT NOT NULL,
  "repairOrderId"    TEXT NOT NULL,
  "action"           "RepairComponentAction" NOT NULL,
  "productId"        TEXT NOT NULL,
  "productReference" TEXT NOT NULL,
  "serialNumber"     TEXT,
  "quantity"         INTEGER NOT NULL DEFAULT 1,
  "disposition"      "RepairComponentDisposition",
  "stockMovementId"  TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "repair_components_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_components_repairOrderId_idx" ON "repair_components"("repairOrderId");
CREATE INDEX "repair_components_productId_idx" ON "repair_components"("productId");

ALTER TABLE "repair_components"
  ADD CONSTRAINT "repair_components_repairOrderId_fkey"
  FOREIGN KEY ("repairOrderId") REFERENCES "repair_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repair_order_events" (
  "id"            TEXT NOT NULL,
  "repairOrderId" TEXT NOT NULL,
  "eventType"     TEXT NOT NULL,
  "payload"       JSONB,
  "actorId"       TEXT,
  "actorName"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "repair_order_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_order_events_repairOrderId_createdAt_idx"
  ON "repair_order_events"("repairOrderId", "createdAt");

ALTER TABLE "repair_order_events"
  ADD CONSTRAINT "repair_order_events_repairOrderId_fkey"
  FOREIGN KEY ("repairOrderId") REFERENCES "repair_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
