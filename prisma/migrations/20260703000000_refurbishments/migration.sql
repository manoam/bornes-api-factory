-- Reconditionnements Factory (V2 chantier metier — combo demontage + assemblage).

CREATE TYPE "RefurbishmentStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'TESTING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "RefurbishmentComponentAction" AS ENUM ('REMOVED', 'INSTALLED');
CREATE TYPE "RefurbishmentDisposition" AS ENUM ('STOCK_NEW', 'STOCK_USED', 'TO_TEST', 'SCRAP');

CREATE TABLE "refurbishments" (
  "id"                  TEXT NOT NULL,
  "borneInternalNumber" TEXT NOT NULL,
  "sourceApp"           TEXT NOT NULL DEFAULT 'unknown',
  "status"              "RefurbishmentStatus" NOT NULL DEFAULT 'DRAFT',
  "reason"              TEXT,
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
  CONSTRAINT "refurbishments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refurbishments_borneInternalNumber_idx" ON "refurbishments"("borneInternalNumber");
CREATE INDEX "refurbishments_status_idx" ON "refurbishments"("status");
CREATE INDEX "refurbishments_createdAt_idx" ON "refurbishments"("createdAt");

CREATE TABLE "refurbishment_components" (
  "id"               TEXT NOT NULL,
  "refurbishmentId"  TEXT NOT NULL,
  "action"           "RefurbishmentComponentAction" NOT NULL,
  "productId"        TEXT NOT NULL,
  "productReference" TEXT NOT NULL,
  "serialNumber"     TEXT,
  "quantity"         INTEGER NOT NULL DEFAULT 1,
  "disposition"      "RefurbishmentDisposition",
  "stockMovementId"  TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refurbishment_components_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refurbishment_components_refurbishmentId_idx" ON "refurbishment_components"("refurbishmentId");
CREATE INDEX "refurbishment_components_productId_idx" ON "refurbishment_components"("productId");

ALTER TABLE "refurbishment_components"
  ADD CONSTRAINT "refurbishment_components_refurbishmentId_fkey"
  FOREIGN KEY ("refurbishmentId") REFERENCES "refurbishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "refurbishment_events" (
  "id"              TEXT NOT NULL,
  "refurbishmentId" TEXT NOT NULL,
  "eventType"       TEXT NOT NULL,
  "payload"         JSONB,
  "actorId"         TEXT,
  "actorName"       TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refurbishment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refurbishment_events_refurbishmentId_createdAt_idx"
  ON "refurbishment_events"("refurbishmentId", "createdAt");

ALTER TABLE "refurbishment_events"
  ADD CONSTRAINT "refurbishment_events_refurbishmentId_fkey"
  FOREIGN KEY ("refurbishmentId") REFERENCES "refurbishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
