-- Ajoute productCategoryId sur refurbishment_components pour le mode
-- "remplacement par categorie" cote UI.
-- Contrainte unique : au plus 1 ligne par (refurb, categorie, action)
-- => on peut avoir 1 REMOVED + 1 INSTALLED sur la meme categorie
-- (l'ancienne pieces + la nouvelle pieces sur ce slot).

ALTER TABLE "refurbishment_components"
  ADD COLUMN "productCategoryId" TEXT;

CREATE UNIQUE INDEX "refurbishment_components_refurb_category_action_key"
  ON "refurbishment_components"("refurbishmentId", "productCategoryId", "action");
