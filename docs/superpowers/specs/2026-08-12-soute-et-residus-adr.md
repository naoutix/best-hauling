# ADR-002 : La soute — cargaison à bord, résidus et vente partielle

**Statut :** Accepté
**Date :** 2026-08-12
**Décideur :** naoutix (propriétaire du dépôt)

## Contexte

Le scénario, tel que vécu :

> J'arrive à la station avec 2 200 SCU de Titanium. Elle n'en reprend que 30. Il me faut donc
> retrouver une station qui reprenne le reste. J'ai en plus 30 SCU de libre que je pourrais
> charger tout de suite.

Aujourd'hui, l'app oblige à trois détours manuels, et **ment sur le résultat**.

### Ce que fait le code aujourd'hui (vérifié)

`manifestLine` pose `acquired: !buy` : une commodité ajoutée à un manifeste dont le terminal de
départ ne la vend pas est classée **butin** — coût nul. Or `manifestTotals` calcule
`profit += units × margin` avec `margin = sellPrice - buyPrice`, donc `margin = sellPrice` quand
`buyPrice` vaut 0.

Sur le scénario ci-dessus (Titanium acheté 1 000, revendu 1 400) :

| | Profit affiché | Investissement |
|---|---:|---:|
| Les 30 SCU vendus sur place | 12 000 | 30 000 |
| Le reste, **tel que l'app le compte** (butin) | **3 038 000** | 0 |
| Le reste, à son coût d'achat réel | 868 000 | 2 170 000 |

> **250 % de surestimation** sur un seul trajet. Le classement des routes qui en découle est faux,
> et il l'est dans le sens le plus trompeur : il flatte le trajet qu'on vient de subir.

Le label « butin » est correct pour ce qu'il désigne — minage, salvage, caisse trouvée, coût
réellement nul. Il est simplement **détourné** de son sens dès qu'on s'en sert pour décrire une
cargaison achetée, faute d'autre moyen de dire « j'ai ça à bord ».

### Ce que les données disent du problème

Sur `data/market.json` (1 879 points de vente) :

| Fait | Chiffre | Conséquence |
|------|--------:|-------------|
| Points dont UEX publie la capacité (`scu_sell`) | **293 / 1 879 (16 %)** | L'app **ne peut pas prédire** le plafond dans 84 % des cas |
| Capacité connue, médiane | 293 SCU | |
| Points qui n'absorbent pas une soute de 96 SCU | 30 % | Le problème existe même en petit vaisseau |
| …de 696 SCU | 71 % | |
| …de 2 200 SCU (Ironclad) | **88 %** | Pour un gros hauler, c'est le cas **nominal**, pas l'exception |
| Débouchés par commodité, médiane | **15 points de vente** | Le résidu a presque toujours où aller |
| Commodités à un seul débouché | 10 sur 113 | Le cas sans issue existe, mais il est rare |

Deux conclusions structurantes :

1. **On ne peut pas deviner le plafond.** Dans 84 % des cas UEX ne le publie pas — c'est
   précisément pourquoi le joueur le découvre **au comptoir**. La fonctionnalité doit donc partir
   d'une **observation**, pas d'une prédiction. C'est exactement le contrat des corrections locales
   et des relevés d'autoload : le joueur mesure, l'app enregistre, et la mesure se périme quand UEX
   republie.
2. **Le résidu a des débouchés** (15 en médiane), donc la question « où écouler le reste ? » a
   presque toujours une réponse — elle est simplement pénible à chercher à la main.

### Ce qui existe déjà et qu'il ne faut pas réinventer

- **Dire « cette station ne reprend que 30 »** est déjà possible : c'est une correction de la
  **demande**, exactement le geste ajouté en #88 — qui gèle au passage les SCU des jambes déjà
  planifiées. Le geste existe ; ce qui manque, c'est **la suite**.
- **Remplir la place libérée** est déjà résolu par `bestManifest` : il suffit de lui passer une
  soute réduite. Aucun moteur nouveau.
- **Chercher où écouler** s'appuie sur `commodityPoints`, qui rend déjà les points de vente triés
  par prix, avec leur demande.
- La **vue Commodités** est le détour manuel actuel — la fonctionnalité doit le rendre inutile,
  pas le remplacer.

### Le problème se décompose en trois, pas un

| # | Problème | État actuel |
|---|----------|-------------|
| **P1** | Le coût d'acquisition d'une cargaison à bord est perdu | Classée « butin », coût 0 → profit faux de 250 % |
| **P2** | Trouver où écouler le résidu | À la main, dans la vue Commodités |
| **P3** | Charger la place libérée sans oublier ce qui reste à bord | À la main, dans Trajets, et fausse P1 |

Et un quatrième en multi-commodité : plusieurs résidus, chacun avec sa capacité résiduelle chez
des stations différentes. **Priorité posée par le propriétaire : la commodité qui rapporte le
plus** — celle qui justifiait le voyage.

## Décision

**Introduire la « soute » : ce qui est à bord, avec son prix payé.** Un état de première classe,
persistant, alimenté par un cycle de course — `chargé → vendu → étape suivante` — et exploité par
trois fonctions pures.

```js
// Une LIGNE PAR LOT : la même commodité peut y figurer plusieurs fois, à des prix différents.
SOUTE = [{ name: "Titanium", units: 2170, paid: 1000, from: "Megumi", at: 1786319687 }]
```

### Le geste qui l'alimente : « J'ai payé ce manifeste »

Le prix payé n'a pas à être saisi : **l'app vient elle-même de le calculer**. Le manifeste dit
quelles commodités, combien de SCU, et à quel prix — c'est exactement la base de coût recherchée.
Un bouton **« ✓ Chargé »** sur la jambe du voyage en fait l'instantané dans la soute.

Ce déplacement du point d'entrée change la nature de la fonctionnalité : la soute n'est plus un
formulaire à entretenir, c'est le **sous-produit d'un geste qu'on fait déjà** — je calcule un
chargement, je vais l'acheter, je confirme. Zéro ressaisie, et la base de coût est exacte par
construction puisqu'elle vient du chiffre que l'app affichait au moment de l'achat.

Le manifeste étant **déjà ajustable** (SCU par ligne, ajout et retrait), l'instantané reflète ce
qu'on a réellement chargé et pas ce qui était prévu : on ajuste, puis on confirme.

> **Une exception assumée à une règle du dépôt.** Le compagnon de voyage ne persiste jamais un
> instantané de marché — seulement l'INTENTION — parce qu'un prix figé continuerait d'afficher la
> valeur du jour de l'édition longtemps après qu'UEX l'ait republiée. `paid` échappe à cette règle,
> et c'est délibéré : **ce n'est pas un instantané de marché, c'est le montant d'une transaction**.
> Il ne vieillit pas, il ne se relit pas, il ne se périme pas — il s'est produit. C'est la même
> différence qu'entre un prix affiché en vitrine et un ticket de caisse.

Ce seul champ `paid` distingue trois natures de cargaison, là où le code n'en connaît que deux :

| Nature | `paid` | Sens |
|--------|--------|------|
| Achetée ici | prix du terminal | le cas normal |
| **À bord, achetée ailleurs** | **prix payé, connu** | **le cas manquant** |
| Butin (minage, salvage) | 0 | coût réellement nul — le label reprend son sens |

Trois fonctions pures dans `logic.mjs`, dans l'esprit des existantes :

1. `sellHere(soute, ventes)` — applique une vente, totale ou partielle : ce qui part, ce qui reste
   à bord avec son prix, et ce qui est marqué « refusé ici ».
2. `offloadPlan(market, soute, origine, f, resolve)` — les destinations classées par **valeur
   réellement écoulable** : `Σ min(résidu, demande) × marge`, résidu le plus cher d'abord.
3. `freeCargo(soute, f)` — les SCU libres, à passer tels quels à `bestManifest`.

Le rendu, lui, reste dans `app.js` : un panneau « Soute » à côté du compagnon de voyage.

## Options considérées

### Option A — La soute comme état global ✅ *retenue*

| Dimension | Évaluation |
|-----------|------------|
| Complexité | Moyenne — un store persisté, 3 fonctions pures, un panneau |
| Portée | Résout P1, P2 et P3 |
| Cohérence | S'appuie sur les corrections locales et sur `bestManifest` |
| Risque | Un second lieu où vit « ce que je transporte », à côté des manifestes de jambe |

**Pour** — Fonctionne **avec ou sans** voyage en cours, ce qui compte : le propriétaire décrit
aller directement dans Trajets. Rend P3 gratuit (`bestManifest` sur la soute libre) et P1 exact
(le coût est enfin porté). Le panneau devient le seul endroit qui répond à « qu'est-ce que je
transporte, et combien ça m'a coûté ».

**Contre** — Deux notions de cargaison coexistent : la soute (réelle, maintenant) et les manifestes
de jambe (planifiés, plus tard). Il faut une règle claire de qui prime, sinon on obtient deux
chiffres contradictoires à l'écran — le défaut que #88 vient justement de corriger ailleurs.

### Option B — La vente partielle, dans la jambe de voyage

| Dimension | Évaluation |
|-----------|------------|
| Complexité | Faible — un champ `vendu` et un champ `paid` dans `JOURNEY_EDITS` |
| Portée | Résout P1 et P3, **dans le voyage seulement** |
| Cohérence | Excellente : le voyage EST déjà la course en cours |
| Risque | Inopérant hors compagnon de voyage |

**Pour** — Aucune notion nouvelle : le parcours porte déjà une intention par jambe, on lui ajoute
« combien est réellement parti ici ». Le reliquat roule vers la jambe suivante avec son prix. C'est
la modélisation la plus juste de ce qui se passe : un voyage est une séquence.

**Contre** — Ne sert que si l'on a construit un parcours. Le propriétaire décrit explicitement le
contraire (« d'habitude je vais dans trajet »). Et un joueur qui découvre le plafond au comptoir
n'a pas forcément planifié la suite — c'est même le contraire.

### Option C — « Où écouler ? », la recherche seule

| Dimension | Évaluation |
|-----------|------------|
| Complexité | **Faible** — une fonction pure + un bouton |
| Portée | Résout **P2 seulement** |
| Cohérence | Parfaite, n'ajoute aucun état |
| Risque | Aucun |

**Pour** — Supprime le détour manuel le plus pénible, immédiatement. Zéro état persistant, zéro
risque de contradiction.

**Contre** — Laisse le mensonge à 250 % intact et n'aide pas à remplir la place libérée. Utile,
mais insuffisant seul.

### Option D — Un champ « prix payé » saisi à la main ❌ *supplantée*

| Dimension | Évaluation |
|-----------|------------|
| Complexité | **Très faible** — un champ de saisie, un `buyPrice` au lieu de 0 |
| Portée | Résout **P1 seulement** |
| Risque | Aucun, sauf l'usure |

**Pour** — Rendait les chiffres honnêtes pour presque rien.

**Contre** — **Fait payer à l'utilisateur un défaut de modèle.** Ressaisir un prix que l'app vient
d'afficher, à chaque étape du reliquat, c'est le symptôme qu'il manque un endroit où l'app se
souvienne de ce qu'on transporte. Le geste « ✓ Chargé » (cf. Décision) obtient le même résultat
sans aucune saisie, en prenant le prix là où il est déjà : dans le manifeste calculé.

**Conservée comme repli**, et à ce titre seulement : pour une cargaison que l'app n'a pas
calculée — déjà à bord avant d'ouvrir le site, ou obtenue autrement — une ligne ajoutée à la main
propose de saisir son prix, « butin » restant offert d'un clic pour le vrai coût nul.

## Analyse des compromis

Le vrai arbitrage n'est pas « quelle option », mais **dans quel ordre**, parce que les options ne
répondent pas au même reproche.

**L'urgence n'est pas l'ergonomie, c'est la justesse.** Un détour manuel coûte du temps ; un profit
faux de 250 % coûte des décisions. Tant que le reliquat est compté comme du butin, chaque trajet
qui en transporte est surévalué, et le classement — la raison d'être de l'app — ment. L'option D,
la plus petite, corrige précisément cela.

**Mais D seule fait payer l'utilisateur pour un défaut de modèle.** Ressaisir un prix à chaque
étape, c'est le symptôme qu'il manque un endroit où l'app se souvienne de ce qu'on transporte.
C'est ce que A apporte, et A rend alors D automatique plutôt que manuel.

**A ou B ?** B est plus élégante — un voyage EST une séquence de ventes partielles, et le store
existe déjà. Mais elle suppose un parcours planifié, or le déclencheur du problème est justement
une **surprise au comptoir**. A fonctionne dans les deux cas, et le voyage peut ensuite lire la
soute plutôt que l'inverse. **La règle qui évite la contradiction : la soute décrit le présent
(ce qui est à bord maintenant), les manifestes de jambe décrivent l'intention (ce qu'on compte
charger plus tard).** Une jambe déjà parcourue ne planifie plus rien ; c'est la soute qui parle.

**Le multi-commodité tranche en faveur d'un plan, pas d'une liste.** Avec deux résidus et des
capacités éparpillées, « où écouler ? » n'a pas une réponse par commodité mais **une réponse par
destination** : quelle station absorbe le plus de valeur d'un coup. La priorité posée — la
commodité qui rapporte le plus d'abord — est exactement le tri glouton que `fillCargo` applique
déjà en sens inverse (remplir par marge décroissante). `offloadPlan` est son dual : **vider par
valeur décroissante**, plafonné par la demande. La machinerie et le vocabulaire existent.

**Ce qu'aucune option ne peut faire.** UEX ignore la capacité de 84 % des points : l'app ne
préviendra donc pas *avant* d'arriver. Elle peut seulement rendre l'après indolore, et retenir la
mesure pour la fois suivante. Le prétendre autrement serait le pire des défauts — un plafond
affiché avec assurance et faux.

## Conséquences

**Ce qui devient plus facile**
- Le profit d'un trajet transportant du fret déjà payé devient exact ; le classement cesse de
  flatter ces trajets.
- « Où écouler mes 2 170 SCU ? » devient une réponse classée, pas une fouille dans Commodités.
- La place libérée se remplit avec le moteur existant, sans oublier ce qui reste à bord.
- « Butin » redevient **vraiment** le butin, ce qui rend la vue Commodités en mode Butin plus juste.

**Ce qui devient plus difficile**
- Deux notions de cargaison cohabitent ; la règle présent/intention doit être écrite, testée, et
  visible à l'écran, sinon on recrée la contradiction que #88 a supprimée ailleurs.
- La soute est un état que l'utilisateur doit **entretenir** : une soute oubliée fausse tout, dans
  l'autre sens cette fois. Il faut un moyen évident de la vider, et sans doute un rappel visuel
  permanent tant qu'elle n'est pas vide.
- **L'app ne peut pas savoir que tu as payé.** « ✓ Chargé » enregistre une intention d'achat comme
  si elle était faite : cliquer puis ne pas acheter — ou acheter moins, faute de stock — installe
  une soute fausse. Trois garde-fous, aucun parfait : l'instantané prend le manifeste **ajusté**
  (on corrige avant de confirmer), la soute reste éditable ligne à ligne, et elle s'affiche en
  permanence tant qu'elle n'est pas vide. C'est le prix à payer pour ne pas ressaisir les prix.
- Le permalien : la soute décrit **ma** course, pas une vue partageable. Elle reste locale, comme
  les corrections et les manifestes édités — une frontière de plus à documenter.

**Ce qu'il faudra revisiter**
- Si UEX se met à publier `scu_sell` largement, la prédiction redevient possible et le manifeste
  pourra prévenir *avant* le départ, plutôt que constater.
- Le voyage pourrait consommer la soute automatiquement à chaque étape franchie — naturel une fois
  A en place, mais c'est un second chantier.

## Plan d'action

Trois livraisons, chacune utile seule, dans l'ordre où elles se rendent service.

1. [ ] **« ✓ Chargé » : la soute existe (P1).** Store local `[{name, units, paid, from}]`, alimenté
       par un bouton sur la carte Manifeste qui en prend l'instantané — donc avec les prix que
       l'app venait d'afficher. Panneau à côté du compagnon, lignes ajustables, bouton « vider ».
       `manifestLine` accepte un `paid` explicite ; le repli manuel (option D) sert aux cargaisons
       que l'app n'a pas calculées. Tests : profit et investissement exacts, non-régression du
       vrai butin à coût nul, et une ligne chargée deux fois à des prix différents.
2. [ ] **La vente partielle (P1 bis).** « La station n'a repris que N » décrémente la ligne de
       soute ; le reste demeure, avec son `paid`. C'est le geste qui produit le résidu, et il
       s'appuie sur la correction de demande qui existe déjà (#88).
3. [ ] **Où écouler + remplir (P2, P3).** `offloadPlan(market, soute, origine, f, resolve)` pur et
       testé : destinations classées par valeur écoulable, résidu le plus cher d'abord, avec la
       distinction **explicite** entre capacité connue et inconnue (84 % des points). Et
       `freeCargo` passe la place libre à `bestManifest`, qui existe déjà.

**Charge estimée** : étape 1 ≈ 150 lignes, étape 2 ≈ 80, étape 3 ≈ 180. L'étape 1 seule rend déjà
les chiffres exacts ; c'est elle qui porte la correction du mensonge à 250 %.

## Décisions d'interface (2026-08-12)

| Question | Décision |
|----------|----------|
| Où vit `✓ Chargé` ? | **Sur la jambe du voyage** — le moment où l'intention devient un fait |
| Symétrique de « chargé » | Un bouton **`Vendu`**, en deux modes : **tout** ou **partiel** |
| Même commodité rechargée | **Lots distincts** — plus complexe, mais juste |
| Résidu sans débouché | **« Déposer à la station »** : le jeu le permet, l'app doit le savoir |
| Péremption de la soute | **Aucune** — une soute vieille peut être exacte (vaisseau rangé plein) |
| Avancer d'une étape | Vaut **« tout vendu »** implicite (voir la réserve ci-dessous) |
| Sur la carte | Une jambe chargée place le vaisseau **entre les deux stations** |

**Le cycle devient un registre de course**, et non plus un plan : `chargé → vendu (tout | partiel)
→ étape suivante`. C'est ce qui rend la soute exacte sans jamais rien ressaisir.

### La réserve, sur l'étape implicite

« Appuyer sur l'étape d'après sous-entend qu'on a tout vendu » est juste **dans le cas courant** —
et faux dans celui qui a motivé cet ADR. Le scénario est précisément : la station n'a repris que
30 SCU, je déclare la vente partielle, **et je repars avec 2 170 SCU à bord**. Si avancer valait
« tout vendu » sans nuance, le résidu serait effacé au moment exact où il devient le sujet.

Règle retenue, qui préserve les deux intentions :

> Avancer d'une étape vend **ce qui restait vendable à cette étape** — c'est-à-dire tout, sauf ce
> qu'une vente partielle a explicitement laissé à bord. Un résidu déclaré est marqué **refusé ici**
> et traverse l'étape intact.

Sans quoi le geste le plus naturel de l'app détruirait silencieusement la donnée la plus précieuse.

### Les lots, et ce qu'ils imposent

La moyenne pondérée était le choix simple ; elle est écartée au profit du **juste**. La soute est
donc une liste de **lots**, et une même commodité peut y figurer plusieurs fois :

```js
SOUTE = [
  { name: "Titanium", units: 2170, paid: 1000, from: "Megumi", at: 1786319687 },
  { name: "Titanium", units: 30,   paid: 1400, from: "Ruin Station", at: 1786402113 },
]
```

Le panneau les regroupe par commodité — un total, et le détail des lots dessous — sinon la soute
devient illisible dès la deuxième course.

**Ce que les lots obligent à trancher : quel lot part en premier ?** Une vente partielle de 30 SCU
sur 2 200 répartis en deux lots doit choisir. Trois règles possibles :

| Règle | Effet sur le résidu | Verdict |
|-------|---------------------|---------|
| **FIFO** (le plus ancien d'abord) | Le résidu porte les achats récents | **Retenue** : standard comptable, déterministe, explicable |
| Le plus cher d'abord | Maximise le profit affiché maintenant, laisse le résidu le moins cher — donc le plus facile à revendre ailleurs | Optimise un chiffre, pas la réalité |
| Au choix, lot par lot | Exact | Une décision à prendre à chaque vente : trop cher payé pour un gain nul |

FIFO est retenu **et affiché** : le panneau montre quel lot part, donc rien ne se décide en
silence. Le jeu, lui, ne distingue pas les lots — c'est un registre, pas une simulation.

### « Déposer à la station » : une troisième sortie

Un résidu n'a que deux issues dans le modèle initial — vendu, ou gardé à bord. Le jeu en offre une
troisième : **le laisser à la station**. C'est souvent la bonne réponse quand le seul débouché est
saturé : on libère la soute sans vendre à perte, et on revient plus tard.

La soute gagne donc une destination, et l'app un second store :

```js
ENTREPOTS = { "Ruin Station — Pyro": [{ name: "Titanium", units: 2170, paid: 1000, at: … }] }
```

Conséquence heureuse : `offloadPlan` peut alors répondre à la question inverse — **« qu'est-ce que
j'ai laissé en route, et est-ce que je passe à côté ? »**. Un dépôt oublié est une perte sèche que
rien aujourd'hui ne rappelle.

### Pas de péremption — mais alors deux gestes distincts

L'argument est juste : reprendre le jeu une semaine plus tard avec un vaisseau rangé **plein**, ce
n'est pas une soute périmée, c'est une soute **exacte**. Aucune date de péremption, donc.

Mais ce même argument impose une séparation : si « effacer le voyage » vidait la soute, alors la
cargaison rangée depuis une semaine disparaîtrait au premier nouveau parcours — précisément le cas
qu'on vient de juger légitime.

> **Effacer le voyage n'est pas vider la soute.** Le parcours est un plan, la soute est du fret
> réel. Deux gestes, deux boutons, et la soute reste affichée tant qu'elle n'est pas vide — c'est
> ce rappel permanent qui remplace la péremption.

### La carte comme état, et non plus comme plan

Placer le vaisseau **entre** les deux stations dès que la jambe est chargée transforme la carte
livrée en ADR-001 : elle cesse de montrer un itinéraire prévu pour montrer **où on en est
réellement** — à quai, ou en vol avec du fret payé à bord. La transition CSS du vaisseau existe
déjà, l'information nouvelle tient dans un booléen par jambe.

## Questions restées ouvertes

Aucune ne bloque l'étape 1.

1. **Un dépôt en entrepôt doit-il apparaître sur la carte du parcours ?** Marquer la station où
   dort du fret oublié serait cohérent avec ADR-001, mais c'est un second chantier.
2. **Le profit d'un voyage doit-il compter le fret déposé ?** Il n'est ni vendu ni perdu : le
   compter en profit serait faux, l'ignorer masquerait un capital immobilisé.
