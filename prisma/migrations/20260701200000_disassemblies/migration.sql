-- Demontages Factory (V2 chantier metier).
-- Pas de TESTING dans le statut — on ne teste pas la borne demontee.
-- Pas de controles qualite.

CREATE TYPE "DisassemblyStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "DisassemblyDisposition" AS ENUM ('STOCK_NEW', 'STOCK_USED', 'TO_TEST', 'SCRAP');

CREATE TABLE "disassemblies" (
  "id"                  TEXT NOT NULL,
  "borneInternalNumber" TEXT NOT NULL,
  "sourceApp"           TEXT NOT NULL DEFAULT 'unknown',
  "status"              "DisassemblyStatus" NOT NULL DEFAULT 'DRAFT',
  "reason"              TEXT,
  "operatorId"          TEXT,
  "operatorName"        TEXT,
  "notes"               TEXT,
  "startedAt"           TIMESTAMP(3),
  "completedAt"         TIMESTAMP(3),
  "createdById"         TEXT NOT NULL,
  "createdByName"       TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "disassemblies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "disassemblies_borneInternalNumber_idx" ON "disassemblies"("borneInternalNumber");
CREATE INDEX "disassemblies_status_idx" ON "disassemblies"("status");
CREATE INDEX "disassemblies_createdAt_idx" ON "disassemblies"("createdAt");

CREATE TABLE "disassembly_components" (
  "id"               TEXT NOT NULL,
  "disassemblyId"    TEXT NOT NULL,
  "productId"        TEXT NOT NULL,
  "productReference" TEXT NOT NULL,
  "serialNumber"     TEXT,
  "quantity"         INTEGER NOT NULL DEFAULT 1,
  "disposition"      "DisassemblyDisposition" NOT NULL,
  "stockMovementId"  TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "disassembly_components_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "disassembly_components_disassemblyId_idx" ON "disassembly_components"("disassemblyId");
CREATE INDEX "disassembly_components_productId_idx" ON "disassembly_components"("productId");

ALTER TABLE "disassembly_components"
  ADD CONSTRAINT "disassembly_components_disassemblyId_fkey"
  FOREIGN KEY ("disassemblyId") REFERENCES "disassemblies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "disassembly_events" (
  "id"            TEXT NOT NULL,
  "disassemblyId" TEXT NOT NULL,
  "eventType"     TEXT NOT NULL,
  "payload"       JSONB,
  "actorId"       TEXT,
  "actorName"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "disassembly_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "disassembly_events_disassemblyId_createdAt_idx"
  ON "disassembly_events"("disassemblyId", "createdAt");

ALTER TABLE "disassembly_events"
  ADD CONSTRAINT "disassembly_events_disassemblyId_fkey"
  FOREIGN KEY ("disassemblyId") REFERENCES "disassemblies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
