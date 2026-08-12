# ADR-001 : Carte 2D du voyage en cours

**Statut :** Accepté
**Date :** 2026-08-12 (décisions d'interface tranchées le même jour, cf. « Décisions d'interface »)
**Décideur :** naoutix (propriétaire du dépôt)
**Premier ADR du dépôt** — la numérotation commence ici. Les deux documents existants de
`docs/superpowers/specs/` sont des specs de conception, pas des décisions d'architecture.

## Contexte

Le compagnon de voyage affiche aujourd'hui un parcours **textuel** : `MEGUMI → RAT'S NEST →
CHECKMATE`, un marqueur « je suis ici », et un manifeste par jambe. On veut le doubler d'un
**panneau carte 2D** : les mêmes arrêts, mais posés dans l'espace, avec un vaisseau qui se déplace
sur l'arrêt sélectionné. L'objectif est **esthétique** — aucune décision de trading n'en dépend.

Cette précision est structurante : une carte décorative n'a pas à être géographiquement juste, mais
elle a le droit d'être **jolie, cohérente et instantanée**. Elle n'a en revanche pas le droit de
peser sur le budget de la page ni d'introduire une dépendance.

### Ce que les données permettent (vérifié, pas supposé)

J'ai interrogé l'API UEX 2.0 sur huit endpoints : `star_systems`, `planets`, `orbits`, `moons`,
`space_stations`, `terminals`, `poi`, `jump_points`.

> **Aucun n'expose la moindre coordonnée.** Ni `x/y/z`, ni rayon orbital, ni angle, ni longitude.

Ce que UEX donne, en revanche :

| Donnée | Disponibilité | Utilité pour la carte |
|--------|---------------|------------------------|
| Hiérarchie `système › planète › lune/orbite › terminal` | complète, sur chaque terminal | **le squelette du placement** |
| `jump_points` (6 liens) | complète, avec les orbites des deux bouts | les corridors inter-systèmes |
| `terminals_distances` (paire à paire) | à la demande, déjà utilisée pour les trajets | inexploitable ici (voir option D) |
| `screenshot` / `screenshot_full` par terminal | partielle | décor éventuel, hors périmètre |

Et ce que porte notre instantané (`data/market.json`, 114 terminaux) :

| Système | Corps nommés | Terminaux |
|---------|--------------|-----------|
| Stanton | Hurston (25), MicroTech (21), Crusader (16), ArcCorp (15) | + 3 sans planète |
| Pyro | Terminus (6), Bloom (6), Pyro V (5), Pyro IV (4), Monox (3), Pyro I (1) | + 2 sans planète |
| Nyx | *aucun* | 7, **tous** sans planète |

**12 terminaux sur 114 n'ont pas de planète**, dont les 7 passerelles (`X Gateway (Y)`) et tout Nyx
— Levski est sur un astéroïde qu'UEX ne rattache à rien. Le placement doit donc traiter le cas
« pas de corps parent » comme un cas **nominal**, pas comme une exception.

Les passerelles se nomment `<destination> Gateway (<système courant>)`. Le nom porte donc le lien :
« Pyro Gateway (Stanton) » est, dans Stanton, la porte vers Pyro. Un saut inter-système se lit dans
le parcours sans aucune donnée supplémentaire.

### Ce qu'internet offre (vérifié le 2026-08-12)

Trois familles de ressources, et une seule est exploitable.

**1. Les images de cartes — inutilisables.** Le wiki `starcitizen.tools` place son texte original
sous CC BY-SA, mais les captures et assets du jeu y sont la propriété de CIG, affichés sous
*fair use* ou permission explicite. Le *fair use* est une défense pour l'usage du wiki, **pas une
licence transmissible** : un dépôt public sous MIT qui redistribue ces images en hérite du
problème, sans en hériter du contexte. Le Fankit officiel de CIG couvre logos et fonds d'écran
sous son propre accord, pas les cartes de système.

**2. La starmap de RSI — des DONNÉES, et elles sont bonnes.** L'endpoint
`POST robertsspaceindustries.com/api/starmap/star-systems/<CODE>` renvoie, pour chaque corps :
`distance` (UA), `latitude`, `longitude` (degrés), `parent_id`, `type` et `size`. Autrement dit,
**exactement les coordonnées polaires que je comptais inventer à la main** :

| Corps | `distance` | `longitude` | | Corps | `distance` | `longitude` |
|-------|-----------:|------------:|-|-------|-----------:|------------:|
| Hurston | 0,859 | −30 | | Pyro I | 0,553 | 53 |
| Crusader | 1,280 | −160 | | Monox | 0,710 | 80 |
| ArcCorp | 1,933 | 65 | | Bloom | 1,190 | 42 |
| microTech | 2,904 | −90 | | Pyro V | 2,870 | 116 |
| | | | | Terminus | 4,570 | 152 |

Les lunes y sont aussi (Cellin, Daymar, Yela, Aberdeen…), avec leur `parent_id`, et les points de
saut portent leur propre `distance`/`longitude` — le corridor inter-système se place donc lui aussi
avec de vraies valeurs.

**3. Les cartes communautaires** dérivent toutes de l'une ou l'autre de ces sources.

### Les deux pièges de la starmap RSI

**C'est la carte du LORE, pas celle du jeu jouable.** Stanton y déclare des points de saut vers
Magnus et Terra, Pyro vers Hadrian, Oso, Castra, Cano — rien de tout cela n'est jouable. Et les
« First Five » annoncés pour **Star Citizen 1.0** sont Stanton, Castra, Terra, Pyro et Nyx : deux
systèmes que l'app ne doit surtout pas afficher aujourd'hui.

La parade est structurelle, pas déclarative : **on ne dessine que ce qui porte un terminal dans
notre propre instantané UEX**. Un corps du lore sans terminal n'est jamais rendu — Castra et Terra
sont donc exclus par construction, aujourd'hui comme après une mise à jour de la starmap. Un test
d'orphelin dans les deux sens (toute planète de `market.json` existe dans la table, et
réciproquement pour ce qu'on rend) transforme cette règle en garde-fou automatique.

Vérification faite : pour les trois systèmes couverts, **la liste des planètes de la starmap
correspond exactement à celle de notre instantané** — 4 pour Stanton, 6 pour Pyro, et Delamar pour
Nyx (où vit Levski).

**La donnée contient des valeurs fausses.** `Pyro IV` est publié à `distance = 0.025`, soit vingt
fois plus près de l'étoile que `Pyro I` (0,553) — l'ordre des orbites en devient absurde. Deux
autres corps de Nyx ont une `latitude` nulle. Il faut donc une petite table de corrections
versionnée, **exactement le motif déjà en place pour `SCU_RELEVES`** (la soute de l'Ironclad) :
nominative, datée, à supprimer dès que la source se corrige.

### Contraintes du dépôt

- **Zéro dépendance runtime** — le site est servi tel quel, `npm` ne sert qu'aux tests et au build.
- **Hors-ligne** — le service worker précache une coquille de 8 fichiers ; tout nouvel asset s'y
  ajoute et impose de bumper `CACHE`.
- **Le calcul vit dans `logic.mjs`**, pur et testé ; `app.js` ne fait que rendre (règle du README).
- **Tout nom venu d'UEX est échappé** — une carte SVG interpolant des noms est une surface de plus.
- **Thème** — palette en variables CSS, look HUD Star Citizen ambre/violet déjà établi.

## Décision

**Une carte SVG dessinée par le code, sur la géométrie réelle publiée par la starmap de RSI.
Aucun asset image, aucune dépendance au runtime.**

Quatre briques :

1. `scripts/fetch-starmap.mjs` — script **à lancer à la main**, pas dans la CI. Il interroge la
   starmap de RSI pour les systèmes que porte notre instantané, ne retient que les corps qui ont un
   terminal, applique la table de corrections, et écrit `data/starmap.json`.
2. `data/starmap.json` — l'instantané versionné (~12 corps : `{ distance, longitude, parent }`).
   Le site ne contacte **jamais** RSI ; si l'endpoint disparaît, la carte continue de fonctionner.
3. `logic.mjs` — une fonction **pure** `journeyMap(journey, starmap)` qui projette le parcours en
   coordonnées 0..1 : disques de systèmes, corps, arrêts, tracé des jambes, position du vaisseau.
4. `app.js` — le rendu SVG et le suivi de `JOURNEY.current`.

Le point d'équilibre est là : on prend les **chiffres** de CIG, pas ses **images**. Une géométrie
publique et vérifiable, un rendu qui reste le nôtre — donc thémable, testable, et sans image
redistribuée.

## Options considérées

### Option A — SVG procédural, géométrie de la starmap RSI ✅ *retenue*

| Dimension | Évaluation |
|-----------|------------|
| Complexité | Moyenne — ~350 lignes au total, dont ~80 de calcul pur |
| Poids | ~4 ko (JSON) + 0 asset binaire |
| Hors-ligne | Gratuit : rien à précacher, tout est déjà dans la coquille |
| Testabilité | Élevée — la projection est pure, donc testable au pixel près |
| Thème | Natif : le SVG hérite des variables CSS, clair/sombre compris |
| Risque juridique | Nul |

**Pour** — Aucun asset externe à héberger, à cacher ou à créditer. Le rendu suit le thème existant
sans retouche. La géométrie est **réelle** : l'ordre des orbites, les angles et le placement des
points de saut viennent de la source de CIG, pas de mon imagination. Une nouvelle planète chez UEX
ne casse rien (anneau de repli), et le test « orphelin » déjà en place pour `SCU_RELEVES` se
transpose. Animation par transition CSS sur `transform`, donc `prefers-reduced-motion` gratuit.

**Contre** — L'endpoint de la starmap est **interne et non documenté** : aucune garantie de
stabilité, aucune licence explicite de réutilisation. La parade est de ne l'appeler qu'**une fois,
à la main**, et de committer l'instantané : le site n'en dépend pas, la CI non plus, et une
disparition de l'endpoint ne casse rien. La carte reste par ailleurs un **schéma** : les rayons
sont compressés pour être lisibles (à l'échelle réelle, un système est surtout du vide).

### Option B — Carte matricielle (assets du jeu ou du wiki)

| Dimension | Évaluation |
|-----------|------------|
| Complexité | Faible pour le rendu, élevée pour l'intendance |
| Poids | 200 ko à 2 Mo par système |
| Hors-ligne | Chaque image entre dans `SHELL` + bump de `CACHE` |
| Testabilité | Faible — on ne teste pas un placement sur pixels |
| Thème | Étranger : une image fixe ne suit ni la palette ni le mode sombre |
| Risque juridique | **Élevé** |

**Pour** — Fidèle, immédiatement « vrai ».

**Contre** — Les rendus de la starmap officielle et les images de `starcitizen.tools` sont des
œuvres de CIG ou de contributeurs sous licence propre. Les embarquer dans un dépôt **public sous
MIT** engage le dépôt, et pas seulement la page. S'y ajoute le calage : sans coordonnées (voir
contexte), placer un terminal sur une image reste **du placement à la main**, corps par corps —
donc exactement le travail de l'option A, avec un poids et un risque en plus. **Rejetée.**

### Option C — Canvas 2D avec moteur d'animation

| Dimension | Évaluation |
|-----------|------------|
| Complexité | Élevée — boucle de rendu, redimensionnement, DPI |
| Poids | Dépendance runtime, ou plusieurs centaines de lignes maison |
| Hors-ligne | Une dépendance de plus dans la coquille |
| Testabilité | Faible — un canvas n'a pas de DOM à interroger en e2e |
| Thème | À recâbler à la main (lecture des variables CSS en JS) |
| Risque juridique | Nul |

**Pour** — Effets riches (traînées, parallaxe, particules).

**Contre** — Casse la règle « zéro dépendance », et surtout **l'e2e** : les 65 tests actuels
s'appuient sur des sélecteurs. Un canvas ne se teste qu'en comparaison d'images. Pour un panneau
décoratif de quelques dizaines d'éléments, c'est un moteur pour rien. **Rejetée.**

### Option D — Géométrie déduite des distances UEX (positionnement multidimensionnel)

| Dimension | Évaluation |
|-----------|------------|
| Complexité | Élevée — MDS au build, stabilité entre reconstructions |
| Poids | Nul à l'exécution |
| Hors-ligne | Gratuit |
| Testabilité | Moyenne |
| Thème | Natif |
| Risque juridique | Nul |

**Pour** — La seule option où les positions viennent de vraies mesures.

**Contre** — 114 terminaux, c'est **6 441 paires** à interroger ; le build actuel ne demande déjà
que les distances des routes retenues, avec un cache par paire d'orbites et une limite de
concurrence — parce que c'est le poste le plus lent du pipeline. Et ces distances sont
**orbite → orbite**, donc identiques pour tous les terminaux d'une même orbite : la projection
écraserait les 25 terminaux de Hurston sur un point. Enfin le résultat n'est pas stable d'un build
à l'autre — la carte bougerait toute seule. **Rejetée**, mais c'est l'option à rouvrir si UEX
publie un jour des coordonnées.

## Analyse des compromis

Le vrai choix n'est pas « SVG ou image » mais **« les chiffres de CIG ou ses images »**.

UEX n'expose aucune coordonnée, mais CIG en publie — sous forme de **données**, pas de rendu. Dès
lors, la question n'est plus « où trouver une géométrie », elle est : cette géométrie sert-elle à
placer des points sur **une image qu'on n'a pas le droit de redistribuer** (B), ou à dessiner
**notre propre carte** (A) ? A obtient la même fidélité de placement, sans image redistribuée,
sans poids dans le cache hors-ligne, et avec un rendu qui suit le thème.

Le second compromis est **fidélité contre lisibilité**, et il penche du même côté. Un système
réel est surtout du vide : à l'échelle, Hurston et microTech seraient deux pixels aux extrémités
d'un cadre vide, et les 25 terminaux de Hurston un seul point. Un schéma à anneaux — rayons
compressés, corps espacés — est **plus lisible que la réalité**, ce qui est précisément ce qu'on
demande à un panneau décoratif. C'est aussi ce que fait la carte du jeu.

Le dernier compromis est le **périmètre du panneau** : montrer un système à la fois (simple, mais
le saut inter-système — le moment le plus spectaculaire d'un parcours — devient invisible) ou les
deux systèmes côte à côte avec le corridor de saut. Je propose **les deux systèmes dès que le
parcours en traverse plusieurs**, parce que c'est exactement là que la carte apporte quelque chose
que le texte ne donne pas.

## Conséquences

**Ce qui devient plus facile**
- Le parcours acquiert une lecture immédiate : où je suis, ce qu'il reste, si je change de système.
- La table de géométrie est un fichier de données : l'affiner ne demande pas de toucher au code.
- La projection étant pure, on peut la tester finement (bornes, cas sans planète, saut, arrêt seul).

**Ce qui devient plus difficile**
- Deux sources à réconcilier au lieu d'une : UEX dit **où sont les terminaux**, RSI dit **où sont
  les corps**. Elles peuvent diverger — une planète renommée d'un côté disparaît de la carte de
  l'autre. Le test d'orphelin est ce qui rend cette divergence bruyante plutôt que silencieuse.
- La starmap est **plus large que le jeu jouable** : sans le filtre « a un terminal », Castra et
  Terra s'inviteraient dès que CIG les publie. La règle doit rester dans le script de collecte
  *et* dans le test, pas seulement dans une intention.
- Les rayons sont **compressés** pour tenir dans un panneau : à l'échelle réelle, microTech est à
  2,9 UA et Hurston à 0,86, donc tout se tasse au centre. À assumer d'une ligne au README.
- `renderJourney()` gagne un rendu supplémentaire ; il tourne déjà à chaque `refresh()` depuis
  #88. La projection doit rester en O(arrêts), et le SVG être ré-écrit d'un seul `innerHTML`.

**Ce qu'il faudra revisiter**
- Si l'endpoint de la starmap ferme ou change de forme, `fetch-starmap.mjs` casse — mais le site,
  non : il ne lit que l'instantané commité. On répare quand on veut, pas dans l'urgence.
- Si UEX publie un jour des coordonnées, elles deviennent la meilleure source (une seule origine
  pour les terminaux ET la géométrie) : `journeyMap` change d'entrée, le rendu ne bouge pas.
- Si le panneau plaît, l'extension naturelle est la vue Chaîne (mêmes jambes, même projection).

## Plan d'action

1. [ ] `scripts/fetch-starmap.mjs` (hors CI) + `data/starmap.json` — 3 systèmes, ~12 corps,
       `{ distance, longitude, parent }` repris de la starmap RSI, **filtrés à ce qui porte un
       terminal**, plus une table de corrections nominative (au moins `Pyro IV`, publié à 0,025).
       Rayons normalisés à l'affichage, pas au stockage : on garde la valeur source.
2. [ ] Test d'orphelin **dans les deux sens** : toute planète de `market.json` a son entrée, et
       aucune entrée ne désigne un corps sans terminal — c'est ce test qui interdit à Castra,
       Terra ou tout ajout « 1.0 » d'apparaître (sur le modèle du test `SCU_RELEVES`).
3. [ ] `logic.mjs` : `journeyMap(journey, starmap)` → `{ systems[], bodies[], stops[], legs[], ship }`
       en coordonnées 0..1. Pure, sans DOM. Le vaisseau est posé sur `stops[journey.current]`.
4. [ ] Tests unitaires : parcours intra-système, parcours à saut, terminal sans planète, arrêt
       unique (voyage « départ posé »), système inconnu (repli), bornes 0..1 respectées.
5. [ ] `app.js` : `journeyMapHTML(map)` → un `<svg viewBox="0 0 100 100">`, inséré dans la carte
       Voyage. Noms échappés. Aucun identifiant non résolu interpolé.
6. [ ] `style.css` : palette héritée, `transition: transform` sur le vaisseau,
       `@media (prefers-reduced-motion: reduce)` qui la coupe.
7. [ ] e2e : le vaisseau suit le clic sur une étape ; un parcours à saut affiche deux systèmes ;
       le panneau disparaît avec le voyage.
8. [ ] README : une ligne dans « Compagnon de voyage » disant que la carte est un **schéma aux
       proportions compressées**, dont la géométrie vient de la starmap publiée par RSI.

**Charge estimée : ~350 lignes**, dont ~80 de calcul pur et ~120 de rendu. Moins que ce que le
sujet laisse craindre, précisément parce qu'on ne cale rien sur une image.

## Décisions d'interface (2026-08-12)

Quatre questions posées avec maquettes à l'appui, quatre réponses.

| Question | Décision | Ce qu'elle implique |
|----------|----------|---------------------|
| Où vit le panneau ? | **Bandeau pleine largeur**, sous la carte Voyage | Le disque respire et le saut inter-système est lisible ; les tableaux descendent d'autant |
| Cliquer un arrêt déplace-t-il « je suis ici » ? | **Oui** | La carte devient un second chemin vers `setJourneyPosition`, déjà offert par le fil d'étapes — rien de neuf à apprendre |
| Fond d'étoiles | **Statique** | Semis déterministe dessiné une fois ; aucun mouvement en périphérie de lecture |
| Longitudes groupées de Pyro | **On garde les vrais angles** | Pyro reste déséquilibré (42° à 152°), Stanton bien étalé. Les étiquettes serrées se règlent par des traits de rappel, pas en déplaçant les corps |

## Questions restées ouvertes

Aucune ne bloque l'implémentation.

1. **Les étiquettes des grappes** : plusieurs terminaux partagent une planète et se serrent
   autour d'elle. Traits de rappel courts, ou n'afficher que les arrêts du parcours ? À trancher
   sur pièce, une fois le panneau en place.
2. **Le panneau doit-il apparaître sans voyage ?** Aujourd'hui non : pas de parcours, pas de carte.
