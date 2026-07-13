-- Reutilise l'enum RepairPriority (deja cree par la migration V2 repair)
-- pour Refurbishment et Disassembly. Meme concept metier, meme valeurs.

ALTER TABLE "refurbishments"
  ADD COLUMN "priority" "RepairPriority" NOT NULL DEFAULT 'NORMAL';

CREATE INDEX "refurbishments_priority_idx" ON "refurbishments"("priority");

ALTER TABLE "disassemblies"
  ADD COLUMN "priority" "RepairPriority" NOT NULL DEFAULT 'NORMAL';

CREATE INDEX "disassemblies_priority_idx" ON "disassemblies"("priority");
