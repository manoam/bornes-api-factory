-- Bornes Factory — initial schema.

CREATE TYPE "ProductionOrderStatus" AS ENUM ('DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "ProductionOrderPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');
CREATE TYPE "AssemblyOrderStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "AssemblyComponentStatus" AS ENUM ('RESERVED', 'INSTALLED', 'REPLACED', 'REMOVED');

CREATE TABLE "production_orders" (
  "id"              TEXT NOT NULL,
  "model"           TEXT NOT NULL,
  "quantity"        INTEGER NOT NULL,
  "status"          "ProductionOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "priority"        "ProductionOrderPriority" NOT NULL DEFAULT 'NORMAL',
  "reason"          TEXT,
  "targetDate"      TIMESTAMP(3),
  "createdById"     TEXT NOT NULL,
  "createdByName"   TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "production_orders_status_idx" ON "production_orders"("status");
CREATE INDEX "production_orders_createdAt_idx" ON "production_orders"("createdAt");

CREATE TABLE "assembly_orders" (
  "id"                  TEXT NOT NULL,
  "productionOrderId"   TEXT NOT NULL,
  "internalNumber"      TEXT,
  "status"              "AssemblyOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "operatorId"          TEXT,
  "operatorName"        TEXT,
  "notes"               TEXT,
  "startedAt"           TIMESTAMP(3),
  "completedAt"         TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assembly_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assembly_orders_productionOrderId_idx" ON "assembly_orders"("productionOrderId");
CREATE INDEX "assembly_orders_status_idx" ON "assembly_orders"("status");

ALTER TABLE "assembly_orders"
  ADD CONSTRAINT "assembly_orders_productionOrderId_fkey"
  FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "assembly_components" (
  "id"                TEXT NOT NULL,
  "assemblyOrderId"   TEXT NOT NULL,
  "productId"         TEXT NOT NULL,
  "productReference"  TEXT NOT NULL,
  "serialNumber"      TEXT,
  "quantity"          INTEGER NOT NULL DEFAULT 1,
  "status"            "AssemblyComponentStatus" NOT NULL DEFAULT 'RESERVED',
  "installedAt"       TIMESTAMP(3),
  "removedAt"         TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assembly_components_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assembly_components_assemblyOrderId_idx" ON "assembly_components"("assemblyOrderId");
CREATE INDEX "assembly_components_productId_idx" ON "assembly_components"("productId");

ALTER TABLE "assembly_components"
  ADD CONSTRAINT "assembly_components_assemblyOrderId_fkey"
  FOREIGN KEY ("assemblyOrderId") REFERENCES "assembly_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
