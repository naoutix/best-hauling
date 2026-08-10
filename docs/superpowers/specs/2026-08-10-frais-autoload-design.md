# Frais d'autoload — conception

*2026-08-10*

## Le problème

Charger et décharger sa soute automatiquement au terminal se paie. L'app ignore ces frais :
elle classe les routes sur un profit brut que le joueur n'encaisse jamais s'il utilise l'autoload.

L'écart n'est pas cosmétique. Les frais ne dépendent **pas** du prix de la commodité : ils
frappent donc proportionnellement à l'inverse de la valeur du fret. Sur un aller simple de
96 SCU (≈ 5 200 aUEC de frais — un aller-retour compte quatre opérations, donc le double) :

| Fret | Valeur de 96 SCU | Poids des frais |
|------|------------------|-----------------|
| Gold @ 28 928 | 2,78 M | 0,2 % |
| Scrap @ 3 265 | 313 k | 1,7 % |
| Waste @ 189 | 18 k | **29 %** |

L'autoload est indolore en haut de tableau et retourne complètement le bas — exactement là où
les marges sont minces et où le classement se joue.

## Les mesures

Relevées en jeu (Star Citizen 4.9) par le propriétaire du dépôt, sur deux stations Pyro, toutes
deux `is_auto_load = 1` et `max_container_size = 32`. **Identiques à l'achat et à la vente**, et
**identiques quelle que soit la commodité** — ce dernier point est le plus structurant : ce n'est
ni un pourcentage ni une commission, c'est une facture de manutention.

### Admin — Endgame (Pyro, faction Rough & Ready)

| Caisses | 8 SCU | 16 SCU | 24 SCU | 32 SCU |
|---------|-------|--------|--------|--------|
| ×1 | 340 | 510 | 645 | 830 |
| ×2 | 530 | 870 | 1 139 | 1 509 |
| ×3 | 720 | — | 1 634 | 2 190 |

### Admin — Ruin Station (Pyro)

| Caisses | 16 SCU | 24 SCU | 32 SCU |
|---------|--------|--------|--------|
| ×1 | 711 | 901 | 1 159 |
| ×2 | 1 215 | 1 593 | 2 111 |
| ×3 | — | — | 3 063 |

> Le relevé 16 SCU ×1 de Ruin a été noté « 71 » ; c'est 711 — valeur reconstruite par le modèle,
> puis confirmée par la cohérence de la base (711 − 504 = 207, identique aux autres séries).

## Ce que les mesures démontrent

**1. Une constante par transaction.** À Endgame, les quatre séries donnent la même base à
l'aUEC près : 340 − 190 = 510 − 360 = 645 − 494,7 = 830 − 680 = **150**.

**2. Le fractionnement se paie.** À Ruin, 32 SCU en une caisse coûte 1 159 ; les mêmes 32 SCU en
deux caisses de 16 coûtent 1 215. Même volume, +56 exactement. Le coût dépend donc du **nombre de
caisses**, pas seulement du volume.

**3. La grille est universelle, la station n'est qu'un multiplicateur.** Terme à terme :

| Caisse | Ruin | Endgame | Rapport |
|--------|------|---------|---------|
| 32 SCU | 952 | 680 | **×1,400** |
| 24 SCU | 693,5 | 494,7 | **×1,402** |
| 16 SCU | 504 | 360 | **×1,400** |
| base | 207 | 150 | ×1,380 |

Trois décimales concordantes sur trois termes indépendants : ce n'est pas un hasard. Une seule
grille tarifaire, un coefficient par station.

**4. La caisse de 24 est un cas réel, pas une erreur de lecture.** Elle tombe sous
l'interpolation 16↔32 de −4,7 % à Ruin et de −4,9 % à Endgame. Deux stations, même écart : c'est
une règle du jeu.

## Le modèle retenu

```
frais ≈ k × (150 + 30 × nombre_de_caisses + 20 × SCU)
```

Confronté aux 18 relevés, avec k = 1 à Endgame et k = 1,4 à Ruin :
**écart maximal 2,8 %, écart moyen 1,6 %** (les trois mesures à 8 SCU tombent à zéro d'écart).

Les constantes sont **ancrées sur Endgame** : k = 1 signifie « tarif Endgame ». Rien d'arbitraire,
elles se déduisent des mesures.

C'est délibérément une **estimation**. La formule elle-même coûte ~3 % ; la vraie incertitude est
`k`, qui varie de 40 % entre les deux seules stations mesurées sur 161. Tout montant affiché doit
donc porter un `≈`.

## Architecture

### Calcul — `logic.mjs`

Fonction pure, testée, aux côtés de ses voisines `enRouteDeals` / `bestManifest` /
`buildChainAdjacency`, conformément à la règle du README (le calcul vit dans `logic.mjs`).

```js
export const AUTOLOAD = { base: 150, perBox: 30, perScu: 20 }; // tarif Endgame, k = 1
export function autoloadFee(scu, maxBox, k)  // → aUEC (nombre entier)
```

`scuBoxes(n)` reçoit un second paramètre optionnel `maxBox` : elle descend aujourd'hui toujours
de 32, alors qu'un terminal plafonné à 16 ne peut pas produire de caisse de 32. Sans paramètre,
comportement inchangé. C'est la seule signature existante modifiée.

### Données — `scripts/build-data.mjs`

Deux champs par terminal dans `market.json`, tirés d'UEX :

| Champ | Source UEX | Note |
|-------|-----------|------|
| `autoload` | `is_auto_load` | 58 terminaux sur 161. Sans lui, l'app facturerait un service indisponible. |
| `maxBox` | `max_container_size` | **Replié sur 32 quand UEX renvoie 0** (33 terminaux concernés). Répartition : 32 → 73, 24 → 32, 16 → 15, 1 → 8, 0 → 33. |

Le repli sur 32 sous-estime les frais plutôt que de les inventer. Sur un terminal réellement
plafonné à 1 SCU, 32 SCU partent en 32 caisses : ≈ 1 750 au lieu de 820, soit plus du double.

### Coefficient `k` par station

Réutilise le stockage des Corrections locales (`localStorage`, jamais partagé, jamais dans le
lien), sous une clé dédiée `autoload|<terminal>`.

L'utilisateur saisit **un montant observé pour une quantité donnée** ; l'app en déduit `k` par
division du montant par la formule à k = 1, en utilisant le `maxBox` du terminal. Exemple : 1 159
pour 32 SCU à Ruin → k = 1 159 / 820 = 1,41.

Les stations non mesurées prennent le **k global**, réglable, **défaut 1,2** (milieu des deux
mesures connues).

### Application dans le moteur

Les frais s'appliquent **deux fois par trajet** — chargement à l'achat, déchargement à la vente —
chacun avec le `k` de sa propre station. Sont concernés `routeMetrics`, `loopMetrics` (quatre
opérations : A→B et B→A), `tripMetrics`, `bestManifest` et `buildChainAdjacency` (deux par saut).

Deux fois, *quand les deux ont lieu* : une ligne de manifeste chargée ici pour être écoulée
ailleurs n'est pas déchargée à l'arrivée, et une ligne déjà en soute (butin, minage, salvage) n'a
pas été chargée au départ. Ces lignes-là ne paient qu'**une** opération.

Trois hypothèses, faute de mesures, à réviser si le jeu les contredit :

1. **Le nombre de caisses est fixé par le terminal d'achat.** Au déchargement on sort les caisses
   qu'on a ; seul le tarif change.
2. **Une transaction par commodité.** Un manifeste à trois commodités paie trois fois la base de
   150. C'est le choix pessimiste.
3. Le board Commodités n'est pas concerné : il n'a pas de quantité.

### Interface

Un interrupteur **Autoload** à côté de « Multi commodité », **inactif par défaut**. Actif :

- les colonnes profit, profit/heure, marge et ROI passent en net ;
- le détail des frais apparaît en infobulle ;
- **le tri suit le profit net** — c'est tout l'intérêt de la fonctionnalité ;
- tout montant estimé porte un `≈`.

La marge nette répartit les frais sur le volume transporté (`marge − frais / SCU`), et le ROI s'en
déduit. Une même colonne garde ainsi la même définition dans les deux modes de la vue Trajets.
Deux cas ne se répartissent pas et rendent les valeurs de marché intactes : aucun frais, et volume
inconnu — une route non bornée n'a pas de SCU sur quoi étaler un coût fixe.

Exception unique : la **jambe de voyage** (`legFromTrip`) retient la marge de marché. Elle est
persistée et encodée dans le permalien `j=`, où une marge nette survivrait à l'extinction de
l'interrupteur et se cumulerait avec les marges brutes des jambes venues des autres vues.

Un terminal dont `autoload` vaut `false` ne se voit facturer aucun frais : le service n'y existe
pas. L'interrupteur et le `k` global entrent dans le permalien ; les relevés par station restent
locaux, comme les corrections.

## Tests

- `autoloadFee` confrontée aux **18 relevés en fixture**, assertion d'écart ≤ 3 %. Un changement
  de grille à un patch fera tomber ce test — c'est le but.
- `scuBoxes` plafonnée : 32 SCU avec `maxBox = 16` → deux caisses, pas une.
- **Non-régression** : interrupteur inactif → profits strictement identiques à aujourd'hui sur les
  six vues. C'est le test qui protège l'existant.
- Un terminal `autoload: false` ne produit aucun frais, interrupteur actif ou non.
- `build-data` : les deux nouveaux champs sont présents et le repli `max_container_size = 0 → 32`
  est vérifié.
- Mise à jour de la matrice « portée des filtres par vue » du README.

## Limites assumées

L'app ne donnera pas le chiffre exact d'une station non mesurée : `k` varie de 40 % entre les deux
connues. Elle affiche une estimation signalée comme telle, ce qui reste très supérieur à l'ignorer.

Les guides communautaires rapportent que l'autoload est peu fiable en 4.9. La fonctionnalité garde
alors tout son intérêt : elle répond à « est-ce que ça vaut le coup de charger à la main ? », qui
est précisément la question que pose un autoload cassé.
