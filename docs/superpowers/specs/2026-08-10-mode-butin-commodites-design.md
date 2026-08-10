# Mode « Butin » — onglet Commodités

**Date** : 2026-08-10
**Statut** : validé, prêt pour le plan d'implémentation

## Problème

L'onglet **Commodités** répond à « où acheter et où revendre pour faire une marge ». Il ne répond pas
à « je viens de trouver cette ressource — elle vaut combien, et où je l'écoule ? ».

Ce cas d'usage (minage, salvage, caisses trouvées, butin de wreck) a deux particularités :

1. **Le coût d'acquisition est nul** → la marge achat→vente n'a aucun sens, seul le prix de revente compte.
2. **Ce qu'on trouve n'est souvent pas achetable** → les commodités concernées sont absentes du site.

Le point 2 est le vrai blocage, et il est en amont du front. `scripts/build-data.mjs:183` filtre :

```js
if (!c.buys.length || !c.sells.length) continue; // uniquement les commodités échangeables
```

Relevé sur l'API UEX au 2026-08-10 : **113 commodités vendables, 87 achetables, donc 36 « vente seule »**
jamais intégrées à `market.json` — Quantainium, Hadanite, Aphorite, Dolivine, Feynmaline, Janalite,
SLAM, Maze, Kopion Horn, Revenant Pod, Souvenirs… c'est-à-dire précisément l'objet de la demande.

Un bouton purement front afficherait donc le prix de revente des commodités qu'on peut déjà acheter,
et raterait toutes celles qu'on trouve.

## Solution

Une bascule **Marché / Butin** dans l'onglet Commodités, adossée à un élargissement du pipeline de
données aux commodités simplement vendables.

### 1. Pipeline : faire entrer le butin dans `market.json`

Dans `scripts/build-data.mjs`, `buildMarket()` retient désormais **tout ce qui est vendable** :

```js
if (!c.sells.length) continue; // tout ce qui est vendable (le butin n'a pas de point d'achat)
```

Aucune autre structure ne change : `buys` reste un tableau, vide pour ces commodités.

**Non-régression.** Tous les consommateurs de `market.commodities` gardent leur comportement, parce
qu'ils partent tous d'un point d'achat :

| Consommateur | Garde-fou existant |
|---|---|
| `enRouteDeals` (logic.mjs:383) | `const b = c.buys.find(...); if (!b) return;` |
| `manifestsFrom` (logic.mjs:406) | idem |
| `fillCargo`, suggestions | itèrent les achats |
| `allMultiTrips` (logic.mjs:497) | construit `origins` depuis `c.buys` |
| `buildBestLegs` (build-data.mjs:145) | boucle `for (const b of c.buys)` |
| `routesForCommodity` (build-data.mjs:103) | `if (!c.buys.length \|\| !c.sells.length) return [];` |

Une commodité sans achat est donc **inerte** pour Trajets, Boucles, En route et Chaîne : ni route,
ni boucle, ni segment. Coût : environ **+20 Ko** sur `market.json` (68 Ko aujourd'hui).

Effets de bord assumés et souhaitables :

- La vue **Corrections** peut désormais corriger le prix de vente d'un minerai à une station.
- Le datalist `#commodityList` gagne les 36 noms ; taper « Quantainium » dans le champ **Commodité**
  ne renvoie aucun trajet, ce qui est exact.

### 2. Bascule Marché / Butin

Un segmenté à deux boutons dans `#commoditiesControls`, au-dessus des modes de tri, réutilisant le
style `.sort-modes` existant :

```
Mode                 [ ◈ Marché ]  [ 💰 Butin ]
Trier le board par   [ Revente ]  [ Code A→Z ]  [ Catégorie ]
```

| | **Marché** (défaut, comportement actuel) | **Butin** |
|---|---|---|
| Commodités listées | échangeables uniquement (achat **et** vente) | toutes les vendables, y compris les 36 « vente seule » |
| Valeur de la tuile | marge max achat→vente | **meilleur prix de vente** |
| 1er bouton de tri | « Marge » | « Revente » (prix de vente décroissant) |
| Heatmap | linéaire relative au max (inchangée) | **par rang** (voir §4) |
| Panneau de détail | Où acheter + Où vendre | **Où l'écouler** seulement |

**Le distinguo « échangeable » se calcule sur les données brutes**, avant application du filtre
avant-postes : `sellOnly = c.buys.length === 0`. Sinon une commodité achetable uniquement en
avant-poste disparaîtrait du mode Marché dès qu'on coche « exclure les avant-postes » — ce serait
une régression.

**Décision** : les commodités « vente seule » n'apparaissent **que** dans le mode Butin. Les ajouter
au board Marché y mettrait 36 tuiles à « — », sans marge, c'est-à-dire du bruit.

### 3. Panneau de détail en mode Butin

L'en-tête porte la réponse directe à « combien ça vaut », puis une colonne unique :

```
💰 QUAN · Quantainium                          170 000 aUEC/SCU
                                          au mieux — Ruin Station (Pyro)

◈ Où l'écouler  (9 · mieux payé d'abord)
  Terminal                 Prix      Demande   Relevé
  Ruin Station (Pyro)      170 000   n.c.      ● 2 h
  …
```

**Prix au SCU uniquement, pas de valeur totale** : ni champ « quantité trouvée », ni dépendance au
filtre Soute. Le joueur multiplie par ce qu'il a.

Les tuiles « vente seule » portent une marque discrète — bordure pointillée et `title`
« introuvable à l'achat — butin / minage » — pour signaler qu'on ne pourra pas s'en réapprovisionner.

### 4. Heatmap par rang en mode Butin

Les prix de revente s'étalent sur cinq ordres de grandeur : Saldynium à 34 000 000 aUEC/SCU contre
Iron Ore à 1 000. Avec la heatmap relative actuelle (`m / max`), tout le board tomberait dans le
palier le plus bas sauf deux tuiles.

En mode Butin, le palier se calcule donc sur le **rang** dans le classement par prix décroissant :

| Rang (centile) | Palier |
|---|---|
| 0 – 15 % | `t-hot` |
| 15 – 40 % | `t-warm` |
| 40 – 70 % | `t-mid` |
| 70 – 100 % | `t-low` |
| `bestSell == null` | `t-none` (cas défensif : la vue Butin retire déjà ces lignes, cf. §5) |

Le rang se calcule sur la **valeur**, indépendamment du tri d'affichage : trier par « Code A→Z » ne
doit pas recolorer le board. Le mode Marché conserve `marginTier()` tel quel.

### 5. Filtres, persistance

- **Filtres** : « légales uniquement » et « exclure les avant-postes » s'appliquent comme aujourd'hui.
  Le champ **Commodité** filtre le board (nom ou code).
- En mode Butin, une commodité dont tous les points de vente sont éliminés par le filtre avant-postes
  (`bestSell == null`) est **retirée du board** : sans point de vente, il n'y a rien à répondre.
- **Persistance** : la bascule entre dans l'état encodé (permalien + `localStorage`) sous la clé `cb`
  (`"loot"` en mode Butin, absente sinon), via `collectState()` / `applyState()`. Le mode de tri du
  board n'est pas persisté aujourd'hui ; ça ne change pas.

## Découpage

| Fichier | Changement |
|---|---|
| `scripts/build-data.mjs` | critère d'inclusion dans `buildMarket()` |
| `logic.mjs` | `commoditySummaries()` : ajoute `sellOnly` à chaque ligne et accepte `f.board` (`"market"` \| `"loot"`, défaut `"market"`) qui décide de l'inclusion ; nouvelle fonction pure de paliers par rang |
| `app.js` | état `commBoard` (`"market"` \| `"loot"`), rendu des tuiles et du détail selon le mode, câblage du segmenté, persistance |
| `index.html` | le segmenté dans `#commoditiesControls` |
| `style.css` | marque « vente seule » sur la tuile, en-tête de synthèse du détail |
| `README.md` | tableau des vues et matrice des filtres |

Le calcul reste **pur dans `logic.mjs`**, le rendu dans `app.js` — séparation existante du projet.

## Tests

**Unitaires — `logic.test.mjs`**

- `commoditySummaries` marque `sellOnly: true` sur une commodité sans point d'achat, `false` sinon.
- `sellOnly` se calcule sur les données brutes : reste `false` si les seuls achats sont en avant-poste
  et que `noOutpost` est actif.
- Mode Marché : les commodités `sellOnly` sont exclues. Mode Butin : elles sont incluses, avec
  `bestSell` correct et `margin: null`.
- Mode Butin : une commodité sans point de vente après filtrage est retirée.
- Paliers par rang : répartition attendue sur une liste connue ; valeurs extrêmes ne concentrent pas
  tout dans `t-low` ; `null` → `t-none` ; ordre de tri d'affichage sans effet sur les paliers.

**Unitaires — `scripts/build-data.test.mjs`**

- Une commodité sans achat entre dans `market.json` avec `buys: []`.
- Elle ne produit **ni route, ni boucle, ni segment** (`routesForCommodity`, `buildBestLegs`).
- Une commodité sans vente reste exclue.

**E2E — `e2e/smoke.pw.mjs`**

- Bascule en Butin : une commodité « vente seule » apparaît sur le board ; la colonne « Où acheter »
  disparaît du détail ; l'en-tête affiche le prix au SCU.
- Retour en Marché : elle disparaît, le détail réaffiche les deux colonnes.
- Le mode survit à un rechargement (permalien / `localStorage`).

## Hors périmètre

- Valeur totale d'un chargement (quantité × prix) — écarté explicitement.
- Prise en compte de la demande restante pour dire « à ce terminal tu ne peux écouler que N SCU » —
  la colonne Demande l'affiche déjà, le calcul multi-terminaux n'est pas demandé.
- Classement des points de vente par distance depuis une position — la vue n'a pas de terminal d'origine.
