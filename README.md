# Best Hauling — Routes commerciales Star Citizen

Site **statique** qui calcule les meilleures routes d'arbitrage de commodités dans Star Citizen,
à partir de l'[API publique UEX Corp](https://uexcorp.space/api/documentation/) (lecture, sans token).
Les données sont rafraîchies **toutes les 30 minutes** par GitHub Actions — mais uniquement
reconstruites/redéployées **quand UEX a réellement changé** — et le site est **installable**
(PWA) et consultable **hors-ligne**.

> Pas de serveur, pas de clé API, pas de coût. Tout tourne côté navigateur sur des JSON pré-calculés.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Démarrage rapide (local)](#démarrage-rapide-local)
- [Déploiement (une seule fois)](#déploiement-une-seule-fois)
- [Architecture](#architecture)
- [Corrections locales](#corrections-locales)
- [Tests](#tests)
- [Personnalisation](#personnalisation)
- [Sources de données](#sources-de-données)

## Fonctionnalités

Six vues, un même moteur de calcul (soute SCU + budget aUEC → unités, coût, profit/voyage, profit/heure) :

| Vue | Ce qu'elle fait |
|-----|-----------------|
| **Trajets simples** | Meilleures routes A→B, triables, avec un **score de fiabilité** composite (rentabilité × fraîcheur × disponibilité) par défaut. Coche **Multi commodité** : liste plutôt les **chargements combinés** (plusieurs commodités d'un même A vers un même B), dépliables (🗺) pour voir le détail par commodité |
| **Boucles ⇄** | Meilleures boucles A⇄B (une commodité à l'aller, une autre au retour) pour ne jamais repartir à vide |
| **En route 🧭** | Depuis un terminal de départ : le fret rentable + un **manifeste optimal** qui remplit la soute avec **plusieurs commodités** vers une même destination (avec suggestions pour combler l'espace libre) |
| **Chaîne ⛓️** | Trajets **multi-sauts A→B→C…** (2 à 4 sauts) : achète, vends, rachète sur place, revends plus loin — recherche par faisceau du circuit le plus rentable |
| **Corrections ✎** | Voir/gérer ses corrections locales et en créer en **cherchant une station** (voir plus bas) |
| **Commodités 📊** | *Big board* type « salle des marchés » : toutes les commodités avec leur **code officiel UEX** (AGRI, QUAN…), triables (marge / code / catégorie), et au clic **tous leurs points d'achat et de vente** — pratique pour trouver **où écouler** une commodité quand une station n'a plus de demande |

Autres éléments :

- **Vaisseau** : autocomplétion par sous-chaîne (128 modèles UEX), remplit la soute automatiquement, affiche la photo.
- **Contraintes désactivables** : couper le budget → meilleure route pour la soute ; couper la soute → meilleure route pour le budget.
- **Multi commodité** (vue Trajets) : balaie tout le marché et propose les **chargements combinés** A→B — la soute se remplit par marge décroissante, plafonnée par le stock et la demande. Seuls les chargements d'**au moins 2 commodités** sont listés (un trajet qui tient en une seule commodité est déjà dans la liste normale). Nécessite la soute activée ; la coche est grisée sinon.
- **Décomposition SCU en caisses** (32/24/16/8/4/2/1) sur le manifeste et en infobulle.
- **Manifeste ajustable** : chaque ligne se modifie à la main — tu peux **dépasser le stock UEX** (vol de fret, relevé périmé…) ; le champ passe en ambre pour le signaler.
- **Schéma de trajet** dépliable (🗺) : système › planète › terminal, type de saut, temps estimé.
- **Fiabilité des données** : pastille d'âge par relevé, filtre de fraîcheur (< 24 h / 3 j / 7 j), point de statut d'inventaire, tag « à vérifier », bandeau global « données d'il y a X h ».
- **Filtres** : commodité, système, même système uniquement, exclure les avant-postes, commodités légales uniquement, limiter au stock & à la demande UEX. Ils ne s'appliquent pas tous à toutes les vues — voir la **[matrice ci-dessous](#portée-des-filtres-par-vue)**.
- **Permaliens & persistance** : l'état (filtres, tri, vue, vaisseau) est mémorisé (localStorage) et encodé dans l'URL → bouton **Partager**.
- **Copier le manifeste**, **raccourcis clavier** (`/` recherche, `1`–`6` vues).
- Systèmes couverts : **Stanton**, **Pyro**, **Nyx**.

### Portée des filtres par vue

Tous les filtres ne s'appliquent pas à toutes les vues — comportement **garanti par des tests** ([voir Tests](#tests)) :

| Filtre | Trajets | Boucles | En route | Chaîne | Corrections | Commodités |
|--------|:-:|:-:|:-:|:-:|:-:|:-:|
| Soute (SCU) | ✅ | ✅ | ✅ | ✅ | — | — |
| Budget | ✅ | ✅ | ✅ | —¹ | — | — |
| Commodité (recherche) | ✅ | ✅ | ✅ | —² | station | ✅ (tableau) |
| Système d'achat | ✅ | ✅ | —³ | —³ | — | — |
| Fraîcheur | ✅ | ✅ | ✅ | ✅ | — | — |
| Même système | ✅ | ✅ | ✅ | ✅ | — | — |
| Exclure avant-postes | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Légales uniquement | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Stock & demande | ✅ | ✅ | ✅ | ✅⁴ | — | — |

¹ Le budget se reconstitue à chaque vente → non pertinent pour une chaîne.
² Une chaîne est multi-commodité par nature.
³ Le terminal de départ est déjà choisi → le menu « système d'achat » serait redondant.
⁴ La chaîne plafonne **toujours** au stock/demande de chaque saut.

## Démarrage rapide (local)

Le site a besoin d'un serveur HTTP (l'app est un module ES et charge des JSON via `fetch` — pas de `file://`).

```bash
npm run serve        # sert le dossier sur http://localhost:4173 (serveur maison, sans dépendance)
# puis ouvre http://localhost:4173/index.html
```

Les `data/*.json` versionnés servent d'**amorce** pour le dev local. Pour les régénérer depuis UEX :

```bash
npm run build        # = node scripts/build-data.mjs  (Node >= 20, fetch natif)
```

Lancer les tests :

```bash
npm test             # tests unitaires (node --test) — fonctions pures, aucune dépendance
npm run e2e          # tests E2E (Playwright) — nécessite: npm install && npx playwright install chromium
```

## Déploiement (une seule fois)

Le workflow [`update-data.yml`](.github/workflows/update-data.yml) **construit les données puis publie le site entier**
(données fraîches comprises) comme **artefact GitHub Pages**. Les JSON ne sont donc pas commités à chaque run
(l'historique git ne gonfle pas).

1. Pousse le dépôt sur GitHub (branche `main`).
2. **Settings → Pages → Source : `GitHub Actions`** ⚠️ *(pas « Deploy from a branch » — le job `deploy` échoue sinon)*.
3. Onglet **Actions** → lance *Mise à jour des routes UEX* une première fois.
4. En ligne sur `https://<pseudo>.github.io/<repo>/`.

Ensuite, le workflow tourne **toutes les 30 minutes** (et à chaque push sur `main`), mais il ne
**reconstruit/redéploie que si les données UEX ont réellement changé** : il compare une *signature
de données* (`data_signature` dans `meta.json`) à celle du site déjà en ligne et s'arrête **avant**
les calculs coûteux (distances) si rien n'a bougé. Les 30 min sont le **plancher de fraîcheur d'UEX**,
qui met ses prix en cache ~30 min ; un push ou un lancement manuel forcent une reconstruction complète.
En cas d'échec, une **issue est ouverte automatiquement** (et refermée au retour à la normale).

## Architecture

```
┌─ Build (GitHub Actions, /30 min · rebuild si UEX a changé) ───┐
│  scripts/build-data.mjs                                        │
│    ├─ GET api.uexcorp.uk/2.0 : terminals, prix, vaisseaux…     │
│    ├─ calcule routes / boucles / graphe de marché             │
│    └─ écrit data/*.json                                        │
│         routes.json · loops.json · ships.json                 │
│         market.json (graphe complet) · meta.json              │
└───────────────────────────┬───────────────────────────────────┘
                            │ artefact Pages
┌─ Front (statique, navigateur) ────────────────────────────────┐
│  index.html                                                   │
│    ├─ logic.mjs   ← fonctions PURES (calcul), testées         │
│    └─ app.js      ← module ES : rendu DOM, état, interactions │
│  sw.js (service worker) + manifest.webmanifest → PWA offline  │
└───────────────────────────────────────────────────────────────┘
```

**Séparation clé** : toute la logique de calcul sans DOM vit dans [`logic.mjs`](logic.mjs)
(temps de trajet, score, `computeUnits`, **filtres partagés** par vue, corrections, remplissage glouton,
chaîne, **graphe de marché**, **résumés de commodités**, décodage d'état…), importée à la fois par
`app.js` (navigateur) et par les tests. `app.js` ne fait que le rendu et le câblage.

Fichiers de données (dans [`data/`](data/)) :

| Fichier | Contenu | Usage |
|---------|---------|-------|
| `routes.json` | Top routes A→B (achat le moins cher → meilleures ventes) | Trajets simples |
| `loops.json` | Meilleures boucles A⇄B | Boucles |
| `market.json` | Graphe d'échange compact (tous les points d'achat/vente, + **code UEX** par commodité) | En route, Chaîne, Corrections, **Commodités** (chargé à la demande) |
| `ships.json` | Vaisseaux avec soute (nom, SCU, photo) | Champ vaisseau |
| `meta.json` | Métadonnées (date, compteurs, systèmes, **`data_signature`**) | Bandeau de fraîcheur + rebuild conditionnel |

### Refresh & rebuild conditionnel

Le workflow tourne **toutes les 30 min** mais évite le travail inutile :

1. Il récupère les prix UEX et calcule une **signature** = `nb de relevés : date_modified max`.
2. Il la compare au `data_signature` du `meta.json` **déjà en ligne** (pas de fichier d'état).
3. **Inchangé** → il s'arrête **avant** le calcul des distances ; ni build, ni déploiement.
4. **Changé** (ou `push` / lancement manuel, qui *forcent*) → build complet + déploiement, et le nouveau `data_signature` est écrit pour le run suivant.

Pourquoi 30 min : UEX met ses prix en cache ~30 min (`Cache-Control: max-age=1800`), donc interroger
plus souvent ne renverrait pas de données plus fraîches. Le dépôt étant **public**, les minutes GitHub
Actions sont gratuites — l'intérêt du rebuild conditionnel est surtout d'**éviter les déploiements à vide**.

## Corrections locales

Quand un relevé UEX est faux, tu peux corriger un **prix** ou un **stock/demande** en cliquant le chiffre
(dans les tableaux ou via la vue **Corrections** → recherche de station). C'est **local** (localStorage,
jamais partagé ni mis dans l'URL) et **intelligent** :

- Une correction est **ancrée** à la date UEX du point au moment où tu la fais.
- Elle est **périmée automatiquement** dès qu'UEX republie ce point avec un relevé plus récent (retour à la valeur UEX, petit flash de notification).
- Sémantique respectée : un **stock d'achat à 0 = terminal vide** (plafonne à 0) ; une **demande brute à 0 = quantité inconnue** (ignorée) ; mais une **demande que _tu_ corriges à 0 = « pas de demande »** (plafonne à 0).

## Tests

- **Unitaires** ([`logic.test.mjs`](logic.test.mjs), [`scripts/build-data.test.mjs`](scripts/build-data.test.mjs)) :
  couvrent les fonctions pures — calcul de routes/boucles/marché, score, contraintes de volume, moteur de
  corrections, persistance, **résumés & points de commodités**, et **filtrage par vue** (chaîne, commodités).
  Runner intégré `node --test`, **zéro dépendance**.
- **E2E de fumée** ([`e2e/smoke.pw.mjs`](e2e/smoke.pw.mjs), Playwright) : non-régression des bugs vécus
  (carte vaisseau au reload, demande corrigée à 0, contrôles qui ne fuient plus, persistance des corrections,
  navigation, schéma) et **cohérence des filtres par vue** (« légales » agit sur Trajets/Boucles/Commodités,
  « même système » contraint la Chaîne). Playwright est une dépendance **de dev uniquement** — le site livré reste sans dépendance.
- **CI** ([`ci.yml`](.github/workflows/ci.yml)) : unitaires + E2E sur chaque push/PR.

## Personnalisation

- Fréquence de mise à jour : le `cron` dans [`update-data.yml`](.github/workflows/update-data.yml).
- Volumes gardés dans les JSON / concurrence des appels : `MAX_ROUTES`, `MAX_LOOPS`, `TOP_SELLS`,
  `FETCH_CONCURRENCY` en tête de [`scripts/build-data.mjs`](scripts/build-data.mjs).

## Sources de données

- **UEX Corp** (utilisée) — la plus complète, API publique, données communautaires.

### Sémantique des volumes UEX (piège)

Les champs de volume ne sont **pas symétriques** entre l'achat et la vente :

| Côté | Champ UEX | Signification |
|------|-----------|---------------|
| Achat | `scu_buy` | SCU **disponibles à l'achat** — utilisable tel quel |
| Vente | `scu_sell` | **Capacité totale** du terminal pour cette commodité |
| Vente | `scu_sell_stock` | Ce que le terminal **détient déjà** (son stock) |

La **demande exploitable** — ce qu'on peut encore écouler — vaut donc `scu_sell - scu_sell_stock`
(capacité restante), et **jamais** `scu_sell_stock`, qui en est l'inverse. `status_sell` n'est que le
ratio des deux : les paliers 1→7 tombent exactement sur les septièmes (1 = quasi vide, forte demande ;
7 = plein, saturé), et `scu_sell_stock <= scu_sell` sur 100 % des relevés.

UEX ne renseigne `scu_sell` que sur **~11 %** des points de vente. Le pipeline encode donc :

- `demand: null` → capacité inconnue, **aucun plafond** de volume à la vente ;
- `demand: 0` → terminal **saturé**, il ne prend plus rien → plafonne à 0 ;
- `demand: n` → capacité restante réelle.

- **SC Trade Tools** (`sc-trade.tools`) — routes optimisées, pas d'API publique documentée.
- **Regolith Co** — plutôt minage/raffinage.
- **API RSI officielle** — pas de marché exposé.

---

Non affilié à Cloud Imperium Games. Les prix et stocks in-game varient : vérifie avant de voler.
