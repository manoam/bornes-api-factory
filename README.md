# Bornes Factory — API

Backend de l'app **Bornes Factory** : l'atelier numérique de Selfizee
(assemblage, réparation, démontage, reconditionnement des bornes Konitys).

C'est l'un des **3 modules métier** distincts :

- **Stock** (existant) — pièces, mouvements, sites
- **Bornes** (existant) — parc, statut d'exploitation, client
- **Factory** (ce repo) — opérations physiques sur les bornes

Le frontend est dans le repo séparé `konitys-factory`.

Voir `docs/ARCHITECTURE.md` pour les responsabilités précises de chaque
app et la roadmap d'intégration RabbitMQ.

## Stack

- Express + TypeScript + Prisma + PostgreSQL
- Auth Keycloak SSO (réutilise le realm Konitys, accepte les tokens
  délivrés à n'importe quelle app du realm)
- Communication HTTP avec Stock API (V1, sera remplacée par RabbitMQ en V2)

## Pré-requis

- Node 20+
- PostgreSQL 15+
- Une instance Stock accessible (Factory l'appelle pour lire produits /
  stocks et créer des mouvements)

## Démarrage

```bash
cp .env.example .env       # éditer DATABASE_URL et STOCK_API_URL
npm install
npx prisma migrate dev     # crée la DB + applique les migrations
npm run dev                # écoute sur http://localhost:3201
```

## Variables d'environnement

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bornes_factory_dev
PORT=3201
CORS_ORIGIN=http://localhost:5273
KEYCLOAK_URL=https://keycloak.orkessi.com
KEYCLOAK_REALM=konitys
KEYCLOAK_CLIENT_ID=stock-management
APP_KEY=factory
GATEWAY_URL=https://plateform-gateway.orkessi.com
PLATEFORM_URL=https://plateform.orkessi.com
STOCK_API_URL=http://localhost:3001/api
```

## Docker

```bash
docker compose up --build
```

Démarre Postgres (port 5435) + l'API (port 3201). Migrations Prisma
appliquées automatiquement au boot.

## Déploiement Coolify

- Service Docker depuis ce Dockerfile à la racine
- Variables d'env à configurer : voir bloc ci-dessus
- Port exposé : `3201`
- Les migrations Prisma sont appliquées au démarrage du conteneur
  (`npx prisma migrate deploy`)

## Endpoints

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Health check (public) |
| `GET` | `/api/production-orders` | Liste ordres de fabrication |
| `POST` | `/api/production-orders` | Créer (admin/manager) |
| `GET` | `/api/production-orders/:id` | Détail + assemblies |
| `PATCH` | `/api/production-orders/:id` | Update (admin/manager) |
| `POST` | `/api/production-orders/:id/plan` | Génère les assemblages (admin/manager) |
| `GET` | `/api/production-orders/:id/requirements` | Besoin vs stock dispo |
| `GET` | `/api/assembly-orders/:id` | Détail d'un assemblage |
| `PATCH` | `/api/assembly-orders/:id` | Update statut/notes/n° interne |
| `POST` | `/api/assembly-orders/:id/components` | Installer un composant |
| `DELETE` | `/api/assembly-orders/:id/components/:componentId` | Retirer un composant |
