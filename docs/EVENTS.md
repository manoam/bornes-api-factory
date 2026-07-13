# Events RabbitMQ publiés par Bornes Factory

Date : 2026-07-13
Statut : à jour V2 Réparation

Référentiel des événements publiés par Factory sur le bus RabbitMQ
Konitys. Utile pour les développeurs d'autres apps (Bornes, Stock,
Hub, Adminpanel) qui doivent réagir à ces événements.

---

## Bus

- **Exchange** : `konitysevents`
- **Type** : topic
- **Transport** : HTTP Management API (port 15672) — voir
  `services/rabbitmqHttp.ts`.

## Format de payload

Tous les événements Factory ont la même enveloppe :

```json
{
  "id": "<id metier>",
  "table": "<nom court, ex: repair_orders>",
  "action": "<verbe, ex: completed>",
  "app": "factory",
  "data": { /* payload metier, voir sections ci-dessous */ },
  "timestamp": "2026-07-13T14:23:45.123Z",
  "actor": {
    "id": "<keycloak sub>",
    "email": "<optional>"
  }
}
```

Le champ `app` est **critique** pour l'anti-boucle : chaque app doit
ignorer les événements où `app` matche son propre `APP_NAME`.

## Routing key

`{APP_NAME}.{table}.{action}` — pour Factory, ça donne :

- `factory.repair_orders.on_hold`
- `factory.repair_orders.resumed`
- `factory.repair_orders.completed`
- `factory.repair_orders.cancelled`
- `factory.refurbishments.completed`
- `factory.refurbishments.cancelled`
- `factory.disassemblies.completed`
- `factory.disassemblies.cancelled`
- `factory.assembly_orders.completed` *(voir Assemblage plus bas)*

---

## Réparation (V2)

### `factory.repair_orders.on_hold`

Publié quand une réparation passe en pause (`IN_PROGRESS → ON_HOLD`).

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "S268",
  "reason": "Attente pièce écran fournisseur"
}
```

Consommateur type : **Bornes** peut afficher une pastille "en attente
atelier" dans son dashboard, ou notifier le commercial.

### `factory.repair_orders.resumed`

Publié quand une réparation reprend (`ON_HOLD → IN_PROGRESS`).

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "S268",
  "previousReason": "Attente pièce écran fournisseur"
}
```

Consommateur type : **Bornes** peut retirer la pastille "en attente"
et notifier que le chantier est de nouveau actif.

### `factory.repair_orders.completed`

Publié à la clôture (`TESTING → COMPLETED`), que ce soit via
`POST /:id/transition to=COMPLETED` ou via `POST /:id/close`.

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "S268",
  "sourceApp": "bornes",
  "completedAt": "2026-07-13T14:23:45.123Z",
  "operator": "Marie Dupont",
  "finalResult": "RESOLVED",
  "report": "Ecran remplacé. Test tactile OK sur 5 zones...",
  "components": [
    {
      "kind": "REPLACED",
      "productId": "<uuid>",
      "productReference": "ECR-15-TOUCH",
      "serialNumber": "SN-TC-9321",
      "quantity": 1,
      "partState": "DEFECTIVE",
      "comment": null
    }
  ],
  "attachments": [
    {
      "id": "<uuid>",
      "filename": "photo_ecran_hs.jpg",
      "url": "/uploads/repairs/abc123.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 234567
    }
  ]
}
```

Champs sémantiques :

- **`finalResult`** :
  - `RESOLVED` — panne corrigée, borne repart
  - `NOT_REPRODUCED` — panne non reproductible en atelier
  - `BEYOND_REPAIR` — borne HS, à retirer du parc
  - `ESCALATED` — remonté fournisseur / R&D
- **`components[].kind`** :
  - `REPLACED` — pièce remplacée (2 mouvements Stock)
  - `CHECKED` — pièce contrôlée sur place (0 mouvement Stock)
  - `DIAGNOSED` — pièce en cours de diagnostic (0 mouvement Stock)
- **`components[].partState`** :
  - `OK` — validée fonctionnelle
  - `DEFECTIVE` — HS confirmé
  - `TO_CHECK` — suspicion
  - `SUSPECT` — anormale, peut lâcher

Consommateur type : **Bornes** remet la borne en statut "prête à
louer" (si `RESOLVED`) ou "à retirer du parc" (si `BEYOND_REPAIR`).
**Stock** peut recouper les mouvements créés avec ce chantier via les
`stockMovementIds` déjà stockés côté Factory.

Note importante : les URLs des pièces jointes sont **relatives**. Le
consommateur doit préfixer avec `BORNES_FACTORY_API_URL` pour construire
l'URL absolue.

### `factory.repair_orders.cancelled`

Publié quand une réparation est annulée depuis n'importe quel statut
non-final.

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "S268",
  "reason": "Client a préféré remplacer la borne complète"
}
```

---

## Reconditionnement

### `factory.refurbishments.completed`

Publié à la validation (`TESTING → COMPLETED`).

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "C150",
  "sourceApp": "factory",
  "reason": "Révision annuelle contrat client",
  "completedAt": "...",
  "operator": "Pierre Martin",
  "components": [
    {
      "action": "REMOVED" | "INSTALLED",
      "productId": "...",
      "productReference": "...",
      "serialNumber": "...",
      "quantity": 1,
      "disposition": "STOCK_USED" | "STOCK_NEW" | "TO_TEST" | "SCRAP"
    }
  ]
}
```

Note : Reconditionnement garde encore la shape V1 (`action` +
`disposition`) — pas migré en V2 pour l'instant.

### `factory.refurbishments.cancelled`

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "C150",
  "reason": null
}
```

---

## Démontage

### `factory.disassemblies.completed`

Publié à la validation (`IN_PROGRESS → COMPLETED`).

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "K012",
  "sourceApp": "factory",
  "reason": "Fin de vie contractuelle",
  "completedAt": "...",
  "operator": "...",
  "components": [
    {
      "productId": "...",
      "productReference": "...",
      "serialNumber": "...",
      "quantity": 1,
      "disposition": "STOCK_USED" | "STOCK_NEW" | "TO_TEST" | "SCRAP"
    }
  ]
}
```

Consommateur type : **Bornes** archive la borne dans le parc.

### `factory.disassemblies.cancelled`

```json
{
  "id": "<uuid>",
  "borneInternalNumber": "K012",
  "reason": null
}
```

---

## Assemblage

À voir : la publication de `factory.assembly_orders.completed` n'est
peut-être pas encore active. À implémenter si Bornes veut être notifié
quand une borne neuve entre dans le parc — piste pour le futur.

---

## Anti-boucle

Chaque événement porte `app: "factory"`. Les autres apps doivent
ignorer les événements où `app === "factory"` si elles ne veulent pas
répondre à leurs propres actions relayées.

Symétriquement, Factory ignore les événements où `app === "factory"`
dans son consommateur `bornes.*` (à implémenter, voir suite du roadmap).

---

## Fail-safe

`publishEvent()` ne throw jamais. Si le bus est down, l'événement est
loggé et la transaction métier qui l'a déclenché a déjà commit. La
divergence sera visible côté audit (`repair_order_events` locale) mais
pas rattrapée automatiquement — à voir avec Seb si on a besoin d'un
mécanisme de rejeu.
