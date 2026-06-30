-- Append-only audit trail for assembly orders + quality check storage.

ALTER TABLE "assembly_orders" ADD COLUMN "qualityChecks" JSONB;

CREATE TABLE "assembly_order_events" (
  "id"                TEXT NOT NULL,
  "assemblyOrderId"   TEXT NOT NULL,
  "eventType"         TEXT NOT NULL,
  "payload"           JSONB,
  "actorId"           TEXT,
  "actorName"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assembly_order_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assembly_order_events_assemblyOrderId_createdAt_idx"
  ON "assembly_order_events"("assemblyOrderId", "createdAt");

ALTER TABLE "assembly_order_events"
  ADD CONSTRAINT "assembly_order_events_assemblyOrderId_fkey"
  FOREIGN KEY ("assemblyOrderId") REFERENCES "assembly_orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
