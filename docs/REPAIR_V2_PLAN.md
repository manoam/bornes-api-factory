# Cadrage — Refonte Réparation V2 (+ Listes chantiers)

Date : 2026-07-08 (décisions figées 2026-07-09)
Auteur : @manoa
Statut : **VALIDÉ — prêt pour dev, décisions figées en §11**

Ce document décrit ce qui change dans la surface Réparation Factory pour
aligner sur le mockup Konitys "S268 — écran tactile ne répond pas".
Sers-t'en pour valider le périmètre avant qu'on code une seule ligne.

Une fois validé, on décidera si on porte les mêmes changements sur
Reconditionnement et Démontage à l'identique ou pas.

---

## 1. Ce qui déclenche cette refonte

Le mockup montre 5 changements structurels par rapport à ce qu'on a
aujourd'hui :

1. **Statut ON_HOLD** (mise en attente) — bouton "Mettre en attente" au
   header. Aujourd'hui on a seulement DRAFT / IN_PROGRESS / TESTING /
   COMPLETED / CANCELLED. Il faut un état intermédiaire "pause" (pièce
   commandée, attente client, …).
2. **Priorité** (Normale / Haute / Urgente). Aujourd'hui, aucune. Le
   backlog atelier ne peut pas être trié.
3. **Actions composant à 3 valeurs** : `REMPLACÉ` / `CONTRÔLÉ` /
   `DIAGNOSTIC`. Aujourd'hui on a `REMOVED` / `INSTALLED` — trop
   restrictif pour la vie d'atelier (une pièce peut être contrôlée
   sans être remplacée, ou entrer en diagnostic sans être retirée).
4. **État de la pièce** après action : `Défectueux` / `À contrôler` /
   `Suspect` / `OK`. Aujourd'hui on a `disposition` sur les retraits
   uniquement — pas d'état intrinsèque à la pièce.
5. **Clôture formelle** : compte-rendu long texte + résultat final +
   pièce jointe optionnelle. Aujourd'hui on a `notes` + `qualityChecks`
   — pas de compte-rendu formel ni de pièce jointe.

**Ce que ces 5 changements permettent** :
- Suivre finement une intervention même sans remplacement
- Faire ressortir les priorités atelier dans les listes
- Retrouver ce qu'un technicien a fait par une simple recherche texte
- Attacher une photo du composant HS ou une facture pièce
- Interrompre proprement une réparation en attente sans devoir la
  brouiller ou l'annuler

---

## 2. Changements schema DB

Migration Prisma unique, à préparer côté `server/prisma/migrations/`.

### 2.1 Enums

```prisma
enum RepairOrderStatus {
  DRAFT
  IN_PROGRESS
  ON_HOLD          // NOUVEAU — en attente (pièce, client, ...)
  TESTING
  COMPLETED
  CANCELLED
}

enum RepairPriority {
  NORMAL           // par défaut
  HIGH
  URGENT
}

// Remplace RepairComponentAction (REMOVED / INSTALLED).
enum RepairInterventionKind {
  REPLACED         // remplacement effectif d'une pièce (implique un OUT+IN Stock)
  CHECKED          // pièce contrôlée sur place, remise en état
  DIAGNOSED        // pièce en cours de diagnostic, décision à venir
}

// Remplace RepairComponentDisposition (TO_TEST / SCRAP / STOCK_USED).
// L'état est intrinsèque à la pièce, plus lié à sa destination.
enum RepairPartState {
  OK                // pièce validée, fonctionnelle
  DEFECTIVE         // HS confirmé, à mettre au rebut
  TO_CHECK          // suspicion, contrôle ultérieur nécessaire
  SUSPECT           // comportement anormal, peut lâcher sous stress
}

enum RepairFinalResult {
  RESOLVED          // panne corrigée
  NOT_REPRODUCED    // panne non reproduite en atelier
  BEYOND_REPAIR     // borne HS, à retirer du parc
  ESCALATED         // remontée fournisseur / R&D
}
```

### 2.2 Table `repair_orders` — colonnes nouvelles

```prisma
model RepairOrder {
  // ... existant conservé
  priority           RepairPriority     @default(NORMAL)       // NOUVEAU
  report             String?                                    // NOUVEAU — compte-rendu long
  finalResult        RepairFinalResult?                        // NOUVEAU — set à la clôture
  onHoldReason       String?                                    // NOUVEAU — motif de mise en attente
  attachments        RepairAttachment[]                        // relation NOUVELLE
}
```

### 2.3 Refactor `repair_components`

```prisma
model RepairComponent {
  // ... conservé : id, repairOrderId, productId, productReference, serialNumber, quantity, stockMovementId, createdAt
  kind               RepairInterventionKind                     // renommage : action → kind, valeurs nouvelles
  partState          RepairPartState                             // renommage : disposition → partState, valeurs nouvelles
  comment            String?                                     // NOUVEAU — commentaire libre par ligne
}
```

**Impact Stock** :
- `REPLACED` : identique à ce qu'on faisait avec REMOVED+INSTALLED — un mouvement OUT (pièce neuve) + un mouvement IN (pièce retirée avec condition selon `partState`)
- `CHECKED` : **aucun mouvement Stock** — la pièce reste en place
- `DIAGNOSED` : **aucun mouvement Stock** — décision remise à plus tard

### 2.4 Nouveau modèle `RepairAttachment`

```prisma
model RepairAttachment {
  id              String       @id @default(uuid())
  repairOrderId   String
  repairOrder     RepairOrder  @relation(fields: [repairOrderId], references: [id], onDelete: Cascade)
  filename        String                       // "IMG_1234.jpg"
  url             String                       // "/uploads/repairs/{uuid}.jpg"
  mimeType        String
  sizeBytes       Int
  uploadedById    String
  uploadedByName  String?
  createdAt       DateTime     @default(now())

  @@index([repairOrderId])
  @@map("repair_attachments")
}
```

### 2.5 Migration : stratégie de backfill

- `priority` → `NORMAL` sur toutes les lignes existantes
- `action` → `kind` : mapping automatique
  - `REMOVED` → `REPLACED` (côté "pièce sortie")
  - `INSTALLED` → `REPLACED` (côté "pièce entrée")
  - On perd le distinguo au niveau de la ligne composant. Choix acceptable si la migration est en dev/staging où les données de test sont sacrifiables. **En prod, à valider si on veut conserver l'historique granulaire ou pas.**
- `disposition` → `partState` : mapping
  - `SCRAP` → `DEFECTIVE`
  - `TO_TEST` → `TO_CHECK`
  - `STOCK_USED` → `OK`
  - `null` (pas de disposition, cas INSTALLED) → `OK`

**Alternative** : garder les anciennes colonnes en parallèle pendant N semaines, ne rien migrer, ajouter les nouvelles avec `?`. Plus safe mais fait de la dette. Décision à prendre.

---

## 3. Transitions de statut

État actuel :

```
DRAFT → IN_PROGRESS → TESTING → COMPLETED
   ↓       ↓            ↓
   CANCELLED
```

Cible V2 :

```
DRAFT → IN_PROGRESS ⇄ ON_HOLD
              ↓
           TESTING → COMPLETED
              ↓         ↑
   CANCELLED (depuis n'importe quel état non final)
```

Règles :
- **IN_PROGRESS → ON_HOLD** : requiert un `onHoldReason` (motif texte court)
- **ON_HOLD → IN_PROGRESS** : reprise sans autre condition
- **COMPLETED** : requiert `finalResult` non nul + tous les 6 contrôles qualité cochés (règle existante conservée)
- **CANCELLED** : depuis DRAFT / IN_PROGRESS / ON_HOLD / TESTING — pas depuis COMPLETED

Boutons header en fonction du statut :

| Statut       | Bouton primaire (bleu)      | Boutons secondaires                    |
|--------------|-----------------------------|----------------------------------------|
| DRAFT        | Prendre en charge → IN_PROG | Annuler                                |
| IN_PROGRESS  | Lancer les tests → TESTING  | Mettre en attente → ON_HOLD · Annuler  |
| ON_HOLD      | Reprendre → IN_PROGRESS     | Annuler                                |
| TESTING      | Clôturer → COMPLETED        | Retour atelier → IN_PROGRESS · Annuler |
| COMPLETED    | —                           | (lecture seule)                        |
| CANCELLED    | —                           | (lecture seule)                        |

---

## 4. Endpoints backend nouveaux / modifiés

### 4.1 Modifiés

- `POST /repair-orders/:id/transition` → accepte `ON_HOLD` en target, requiert `onHoldReason` dans le body
- `POST /repair-orders/:id/components` → renomme `action` → `kind`, `disposition` → `partState`, accepte `comment`. La création de mouvement Stock ne se fait que si `kind === REPLACED`
- `PATCH /repair-orders/:id` → accepte `priority`, `report`

### 4.2 Nouveaux

- `POST /repair-orders/:id/attachments` (multipart/form-data) — upload d'un fichier, retourne le `RepairAttachment` créé. Utilise multer + stockage disque local dans `uploads/repairs/`
- `DELETE /repair-orders/:id/attachments/:attachmentId` — suppression fichier + ligne DB
- `POST /repair-orders/:id/close` — endpoint dédié clôture : body `{ report, finalResult }`, atomiquement passe à COMPLETED + set `report`, `finalResult`, `completedAt`

### 4.3 Publication RabbitMQ

- `factory.repair_orders.on_hold` — NOUVEAU (permet aux autres apps de savoir qu'une réparation est en pause)
- `factory.repair_orders.completed` — payload enrichi avec `finalResult`

---

## 5. Refonte fiche détail frontend

### 5.1 Blocs (dans l'ordre vertical)

#### Bloc 1 — Header
- Titre : `S268` (n° interne borne, gros)
- Sous-titre : `Réparation · Borne du parc`
- Boutons droite (dépendent du statut, voir tableau §3) :
  - Primaire : **Prendre en charge** / **Reprendre** / **Lancer les tests** / **Clôturer** (bleu Konitys)
  - Secondaire : **Mettre en attente** / **Retour atelier** (blanc)
  - Menu déroulant **Plus d'actions** : **Annuler la réparation**, autres actions rares

#### Bloc 2 — Bandeau "Problème signalé"
- Fond rose pâle + icône alerte
- Titre : **Problème signalé** (rouge)
- Diagnostic en gros (h2)
- Source en petit : *"Remonté lors du retour atelier"* (à voir : d'où vient la source — set à la création, dérivé de `sourceApp` ?)

#### Bloc 3 — Borne concernée (6 champs)
Grille 3 colonnes × 2 lignes :
| Parc              | Gamme       | Type                    |
| Affectée à        | N° de série | Priorité                |

Sources :
- Parc, Gamme, Affectée à → API Bornes (snapshot)
- Type → à trouver (`type_nom` dans API Bornes ?)
- N° de série → nouvelle donnée à traquer : est-ce le SN externe de la borne (différent du n° interne) ? À valider
- Priorité → nouveau champ `priority` sur `RepairOrder`

#### Bloc 4 — Déclaration d'intervention
Table :
| Élément            | Action    | Référence      | N° de série  | État          |
|---------------------|-----------|-----------------|---------------|---------------|
| Écran tactile 15"  | Remplacé  | ECR-15-TOUCH   | SN-TC-9321    | Défectueux    |
| Câble USB tactile  | Contrôlé  | CAB-USB-TCH    | —             | À contrôler   |
| Carte contrôleur   | Diagnostic| CTRL-TOUCH-V2  | SN-CT-5520    | Suspect       |

En bas, ligne **Synthèse** :
> *1 élément remplacé · 1 élément contrôlé · 1 en diagnostic*

Bouton en haut à droite : **Ajouter une action matériel** → modale/inline pour créer une ligne.

#### Bloc 5 — Clôture de réparation
Bordure orange, titre orange *"Obligatoire pour terminer la réparation"*.

- Récapitulatif de l'intervention (4 badges compacts) :
  - Matériel remplacé : Oui / Non
  - Éléments remplacés : N
  - Éléments contrôlés : N
  - Éléments en diagnostic : N
  - Bouton **Modifier la déclaration** (scroll vers Bloc 4)

- Champ **Compte-rendu atelier** * (textarea long)
- Champ **Résultat final** * (dropdown : `RESOLVED` / `NOT_REPRODUCED` / `BEYOND_REPAIR` / `ESCALATED`)
- Bouton **Ajouter une pièce jointe** (optionnel) → multipart upload
- Bouton **Clôturer la réparation** (violet, désactivé si champs requis vides)

Ce bloc n'est visible qu'en statut TESTING.

#### Bloc 6 — Historique
Timeline verticale, pastilles bleues à gauche, texte à droite. Format existant conservé mais restylé si nécessaire.

### 5.2 Contrôles qualité — que deviennent-ils ?

Aujourd'hui : 6 checkboxes hardcodés côté `config/qualityChecks.ts`, requis pour COMPLETED.

**Options** :
- **A** : conserver tel quel — les checkboxes vivent dans un bloc dédié entre la déclaration et la clôture
- **B** : les intégrer dans le bloc clôture (dérouler sous le compte-rendu)
- **C** : les remplacer par le champ `finalResult` — la clôture avec `RESOLVED` implique que les contrôles sont passés

Mon avis : **A** — les contrôles qualité sont orthogonaux au résultat. Une intervention `NOT_REPRODUCED` peut avoir besoin des mêmes contrôles qu'une `RESOLVED`.

**Décision à prendre.**

---

## 6. Refonte liste (Réparation)

Colonnes cibles, en fonction du retour de la capture :

| Borne | Motif | Opérateur | Créé par | Comp | Créé le | État |

- **Borne** : `C158 — Classik — Vente — Terres d'Armor` inline, séparé par tirets. Petit tag statut Factory/Parc en 2e ligne
- **Motif** : diagnostic tronqué à 60 chars
- **Opérateur** : avatar + nom (`operatorName`)
- **Créé par** : avatar + nom (`createdByName`)
- **Comp** : nombre de composants (tabular-nums)
- **Créé le** : avatar de `createdByName` en petit + date
- **État** : badge coloré (Brouillon / En cours / En attente / En test / Terminé / Annulé)

Backend : la route `GET /repair-orders` retourne pour chaque row les champs `borneGamme`, `borneParc`, `borneEnseigne`, `borneAffecteeA`. **Un seul appel `getBornesSnapshot()` par requête** (snapshot cache 60s côté serveur), puis chaque row pioche dans la Map.

Zebra : `.table-zebra` ajoutée sur la `<table>` (règle CSS déjà en place côté Stock à porter côté Factory).

---

## 7. Report sur Reconditionnement et Démontage

**Après validation de la V2 Réparation**, on décide si :

- **Option i** — On refait Reconditionnement et Démontage sur le même modèle (statut ON_HOLD, priorité, actions 3-états, clôture formelle, pièces jointes). Homogénéité maximale, coûte 2×.
- **Option ii** — On garde Reconditionnement et Démontage tels quels, on ne fait évoluer que Réparation. Différence de traitement selon la nature du chantier.
- **Option iii** — Partiel : on ajoute juste la priorité et le zebra sur Reconditionnement et Démontage, sans refondre la fiche détail. Moins riche mais homogène en surface.

**Décision à prendre après livraison V2 Réparation.**

---

## 8. Découpage en lots de livraison

Ordre logique, du plus rapide au plus profond :

### Lot 1 — Listes enrichies (~1h30)
- Backend : enrichir `GET /repair-orders`, `/refurbishments`, `/disassemblies` avec données parc
- Frontend : colonnes réordonnées, cellule borne inline, avatar créé par, zebra

Livrable visible immédiatement. Zero refonte DB.

### Lot 2 — Schéma DB Réparation V2 (~1h)
- Migration Prisma : enums nouveaux, colonnes RepairOrder, refactor RepairComponent, RepairAttachment
- Adapter `refurbishmentController` et `disassemblyController` si conflit (probablement rien à toucher)

### Lot 3 — Endpoints backend V2 (~1h30)
- `POST /repair-orders/:id/transition` supporte `ON_HOLD`
- `POST /repair-orders/:id/close`
- `POST /repair-orders/:id/attachments` (multer)
- Adapter `addComponent` au nouveau modèle

### Lot 4 — Fiche détail V2 (~3h)
- Refonte complète `RepairOrderDetail.tsx`
- Nouveaux composants : `AttachmentUploader`, `InterventionTable`, `ClosureCard`
- Boutons contextuels selon statut

### Lot 5 — Publication `on_hold` (~15min)

### Lot 6 — Décision Report sur Recond/Démont

Total estimé : **7h à 8h de dev** hors imprévus.

---

## 9. Points ouverts à trancher avant de coder

1. **Backfill migration** : simple mapping REMOVED/INSTALLED → REPLACED, ou on garde les anciennes colonnes en parallèle ? (§2.5)
2. **N° de série de la borne** : c'est quoi exactement dans la vraie vie ? Le n° interne (`C158`) ou un SN externe additionnel ? (§5.1 Bloc 3)
3. **Champ "Type"** dans le bloc Borne : d'où vient-il ? Il y a `type_nom` dans l'API Bornes ? (§5.1 Bloc 3)
4. **Source du diagnostic** ("Remonté lors du retour atelier") : c'est stocké où ? Nouveau champ ou dérivé du `sourceApp` ? (§5.1 Bloc 2)
5. **Contrôles qualité** : options A / B / C ? (§5.2)
6. **Report sur Reconditionnement et Démontage** : options i / ii / iii ? (§7)
7. **Pièces jointes** : stockage disque local (comme `uploads/` actuel Factory) ou S3 dès maintenant ? (§4.2)

---

## 11. Décisions figées (session 2026-07-09)

Ce chapitre synthétise toutes les décisions prises lors de la review du doc.

### §1 — 5 changements structurels
- **Validés tels quels**. ON_HOLD, priorité, actions à 3 valeurs, état pièce, clôture formelle.

### §2 — Schéma DB
- **Enums** : les 4 valeurs de `RepairFinalResult` (RESOLVED / NOT_REPRODUCED / BEYOND_REPAIR / ESCALATED) et les 4 valeurs de `RepairPartState` (OK / DEFECTIVE / TO_CHECK / SUSPECT) sont **toutes conservées**.
- **Colonnes RepairOrder** : `priority`, `report`, `finalResult`, `onHoldReason`, `attachments` — validés.
- **Refactor RepairComponent** : `kind` (REPLACED/CHECKED/DIAGNOSED), `partState` (OK/DEFECTIVE/TO_CHECK/SUSPECT), `comment` — validés.
- **Table RepairAttachment** : validée.
- **Impact Stock** : `REPLACED` = mouvements OUT+IN comme aujourd'hui. `CHECKED` et `DIAGNOSED` = **aucun mouvement**.
- **Migration** : simple, données de test uniquement. Drop des anciennes colonnes, pas de backfill.

### §3 — Transitions
- Graphe simple validé (DRAFT → IN_PROGRESS ⇄ ON_HOLD → TESTING → COMPLETED, CANCELLED depuis n'importe où sauf COMPLETED).
- Guard TESTING : au moins 1 composant enregistré (règle actuelle).
- **Pas** de saut IN_PROGRESS → COMPLETED. **Pas** de réouverture COMPLETED. On ajoutera si un besoin remonte à l'usage.

### §4 — Endpoints backend
- **Tout comme dans le doc** : `transition` supporte `ON_HOLD`, nouveau `close`, nouveau `attachments` en multipart, `addComponent` adapté, nouveau event `factory.repair_orders.on_hold`, payload `completed` enrichi avec `finalResult`.

### §5 — Fiche détail
- Les 6 blocs du mockup reproduits à l'identique.
- **N° de série borne** (Bloc 3) : je réutilise `borneInternalNumber`. Si l'API Bornes expose un vrai SN externe distinct, je l'affiche à la place. Sinon fallback sur l'internal.
- **Type** (Bloc 3) : `type_nom` depuis l'API Bornes si dispo, sinon "—".
- **Source du diagnostic** (Bloc 2) : nouveau champ `diagnosisSource` optionnel sur `RepairOrder`. Valeur par défaut selon `sourceApp` : `"Créé manuellement"` (factory) ou `"Remonté du parc"` (bornes).
- **Contrôles qualité** (§5.2) : **option A** — bloc dédié, orthogonaux au résultat final.

### §6 — Liste Réparation
- Colonnes réordonnées : Borne | Motif | Opérateur | Créé par | Comp | Créé le | État.
- Cellule borne inline : `C158 — Classik — Vente — Terres d'Armor`.
- Avatar `créé par` devant la date "Créé le".
- Zebra sur la table.

### §7 — Report sur Reconditionnement / Démontage
- **Option iii** : ajouter juste priorité + zebra sur Recond/Démont. **Pas** de refonte de la fiche détail des 2 autres pour l'instant.

### §8 — Ordre de livraison
- Lot 1 (listes enrichies + zebra) → Lot 2 (schema) → Lot 3 (endpoints) → Lot 4 (fiche détail) → Lot 5 (event on_hold).

### Autres points ouverts
- **Pièces jointes** : stockage disque local (`uploads/repairs/`). S3 pour plus tard si besoin.
- **Migration** : simple (déjà tranché §2).

---

## 10. Ce qu'on NE change PAS

- Structure atomique `borneInternalNumber` : reste la clé de la borne
- Timeline borne (`/bornes/:internal`) : couvre déjà la vie du chantier, ok tel quel
- Timeline pièce (`/components/:sn`) : idem
- Consumer `bornes.*` : hors scope V2 (attend le publisher externe)
- Permissions Konitys côté Factory : hors scope V2 (le CLAUDE.md perms ne s'applique qu'au repo Stock, Factory n'y est pas soumis pour l'instant)
