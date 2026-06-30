# Architecture — Bornes Factory

## Découpage des responsabilités

```
                 ┌────────────────┐
                 │   App Bornes   │  source de vérité : parc
                 │ statut / parc  │
                 └───────▲────────┘
                         │
                         │ Factory publie l'état final des bornes produites
                         │
┌──────────────┐   ┌──────┴───────────┐
│  App Stock   │◄──│  Borne Factory   │
│ source de    │   │ orchestre les    │
│ vérité :     │   │ operations       │
│ pieces       │   │ physiques        │
└──────────────┘   └──────────────────┘
   ▲                       │
   │                       │
   └───────────────────────┘
   Factory consomme du stock via :
   - V1 (MVP) : HTTP synchrone vers Stock API
   - V2       : Events RabbitMQ
```

### Stock
- **Sait** : quelles pièces existent, combien il y en a, où, dans quel état, lesquelles sont réservées / consommées / HS
- **Ne sait pas** : pourquoi une borne est en réparation, dans quel processus
- **Publie (V2)** : `stock.product.*`, `stock.movement.completed`, `stock.serial.status_changed`

### Bornes
- **Sait** : qu'une borne existe, son numéro, son modèle, son statut global, son client, son emplacement, son historique d'exploitation
- **Ne sait pas** : la composition technique détaillée (PC SN123, imprimante SN456...)
- **Publie (V2)** : `bornes.borne.created`, `bornes.borne.status_changed`

### Factory (ce repo)
- **Sait** : pourquoi une pièce a été consommée, dans quel processus, par qui, pour quelle borne, avec quel diagnostic, avec quel résultat
- **Ne sait pas** : stock global, parc global — il les consulte chez les autres
- **Publie (V2)** : `factory.production.created`, `factory.assembly.completed`, `factory.repair.completed`

### Règle absolue
Factory **n'écrit jamais directement** dans Stock ou Bornes. Elle :
- **Demande** à Stock un mouvement (commande)
- **Notifie** Bornes qu'une nouvelle borne est prête (event)

## Modèle de données Factory (MVP)

### `production_orders`
Décision de fabriquer N bornes d'un modèle donné. Pas encore de borne réelle, juste l'intention.

```
id              uuid
model           string         # "Borne Kalifun", "Borne Spherik", etc.
quantity        int            # nb de bornes à produire
status          enum           # DRAFT, PLANNED, IN_PROGRESS, COMPLETED, CANCELLED
priority        enum           # LOW, NORMAL, HIGH
reason          string?        # "saison été", "commande client", etc.
targetDate      date?          # date cible
createdById     string         # Keycloak sub
createdByName   string?
createdAt       timestamp
updatedAt       timestamp
```

### `assembly_orders`
Une borne en train d'être assemblée. Un `production_order` génère N `assembly_orders` (N = `quantity`).

```
id                  uuid
productionOrderId   uuid -> production_orders.id (cascade)
internalNumber      string?       # "S401" — numéro interne, attribué à la validation
status              enum          # DRAFT, IN_PROGRESS, TESTING, COMPLETED, CANCELLED
operatorId          string?       # Keycloak sub
operatorName        string?
notes               string?
startedAt           timestamp?
completedAt         timestamp?
createdAt           timestamp
updatedAt           timestamp
```

### `assembly_components`
Le détail technique : tel PC SN123 a été installé dans tel assembly_order.

```
id                 uuid
assemblyOrderId    uuid -> assembly_orders.id (cascade)
productId          string         # ID du produit côté Stock (pas de FK)
productReference   string         # cache pour affichage sans round-trip Stock
serialNumber       string?        # n° de série si tracké
quantity           int            # par défaut 1
status             enum           # RESERVED, INSTALLED, REPLACED, REMOVED
installedAt        timestamp?
removedAt          timestamp?
createdAt          timestamp
```

## Communication avec Stock (V1)

Tous les appels passent par `server/src/services/stockClient.ts`.

```ts
stockClient.getProduct(id)                  // GET /products/:id
stockClient.searchProducts(q)                // GET /products?search=...
stockClient.getStockMatrix()                // GET /stocks
stockClient.createMovement(payload)         // POST /movements
stockClient.getAssemblyType(name)           // GET /assembly-types/:id
```

Le token Keycloak du user est propagé automatiquement (Bearer header).

### Calcul du besoin en composants

1. Factory lit la nomenclature `assembly_type.items` chez Stock pour le modèle demandé
2. Pour chaque item : `qty_per_unit × production_order.quantity`
3. Lit le stock dispo via `getStockMatrix()`
4. Renvoie `{ needed, available, missing }` au client

## Communication avec Bornes (V1)

Pour le MVP, Factory n'écrit pas dans Bornes. Quand un assemblage est complété, on **stocke localement** la borne produite (champ `internalNumber` + `completedAt`). L'export vers Bornes se fera **manuellement** ou via un script batch en attendant RabbitMQ.

## Roadmap d'intégration RabbitMQ (V2)

1. Setup RabbitMQ sur Coolify (ou CloudAMQP)
2. Définir le contrat d'événements dans `docs/EVENTS_CONTRACT.md`
3. Stock ajoute un publisher : émet `stock.product.created`, `stock.movement.completed`...
4. Bornes ajoute un publisher et un consumer
5. Factory ajoute un consumer (read model produits + stocks locaux) et un publisher (`factory.assembly.completed`)
6. On supprime progressivement les appels HTTP `stockClient.*` au profit des events

Voir `docs/EVENTS_CONTRACT.md` (à créer en V2).
