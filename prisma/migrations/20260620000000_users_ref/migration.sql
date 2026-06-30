-- Read-only local copy of Konitys users, fed by RabbitMQ events `*.users.*`
-- via services/refSync.ts. All columns nullable except `id`.

CREATE TABLE "users_ref" (
  "id"         INTEGER NOT NULL,
  "email"      VARCHAR,
  "nom"        VARCHAR,
  "prenom"     VARCHAR,
  "username"   VARCHAR,
  "photo_nom"  VARCHAR,
  "photo_url"  VARCHAR,
  "actif"      BOOLEAN,
  "created_at" TIMESTAMPTZ,
  "updated_at" TIMESTAMPTZ,
  CONSTRAINT "users_ref_pkey" PRIMARY KEY ("id")
);
