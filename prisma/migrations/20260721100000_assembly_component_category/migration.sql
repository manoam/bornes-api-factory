-- Ajoute productCategoryId sur assembly_components et l'index unique
-- (assemblyOrderId, productCategoryId) : au plus une ligne par categorie
-- par assemblage.
--
-- Les lignes existantes recoivent NULL, ce qui n'entre pas dans la
-- contrainte unique partielle (Postgres considere NULL != NULL par
-- defaut avec un index unique standard).

ALTER TABLE "assembly_components"
  ADD COLUMN "productCategoryId" TEXT;

CREATE UNIQUE INDEX "assembly_components_assemblyOrderId_productCategoryId_key"
  ON "assembly_components"("assemblyOrderId", "productCategoryId");
