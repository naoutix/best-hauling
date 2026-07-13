# Best Hauling — Routes commerciales Star Citizen

Site statique qui affiche les meilleures routes d'arbitrage de commodités dans Star Citizen.
Les données viennent de l'[API publique UEX Corp](https://uexcorp.space/api/documentation/)
(lecture sans token) et sont rafraîchies automatiquement par GitHub Actions.

## Comment ça marche

```
GitHub Actions (cron horaire / push)
   ├─ node --test                    (tests des fonctions de calcul)
   └─ node scripts/build-data.mjs
        ├─ GET api.uexcorp.uk/2.0/terminals?type=commodity
        ├─ GET api.uexcorp.uk/2.0/commodities_prices_all
        ├─ calcule les meilleures routes (achat le moins cher → vente la plus chère)
        └─ écrit data/routes.json + data/meta.json
                                   │
        assemble _site/ (html+js+css+data) ─→ publie l'artefact GitHub Pages
                                   │
GitHub Pages (page statique)  ────┘
   └─ index.html + app.js chargent data/routes.json
        └─ calcul du profit/voyage selon ta soute (SCU) et ton budget (aUEC)
```

Pas de serveur, pas de clé API, pas de coût.

## Fonctionnalités

- Liste triable : profit/voyage, marge/SCU, ROI, unités, commodité.
- Interface thème **Star Citizen** (sombre, anguleux, accents cyan), icônes de catégorie
  colorées par commodité (métal, minerai, gaz, médical, drogue…) et **photo du vaisseau** sélectionné.
- Champ **vaisseau** avec autocomplétion par sous-chaîne (taper « railen » trouve « Gatac Railen »)
  qui remplit automatiquement la soute (SCU) — 128 modèles UEX.
- Entrées **capacité de soute (SCU)** et **budget (aUEC)** → unités à acheter, coût total, profit réel par voyage.
- Chaque contrainte est **désactivable** : couper le budget → meilleure route pour ta soute peu
  importe le prix ; couper la soute → meilleure route pour ton budget peu importe le volume.
- **Profit/heure** : estimation du temps de trajet à partir de la distance UEX (orbite→orbite)
  + manutention + saut inter-système, pour classer les routes par rentabilité horaire.
- Vue **Boucles aller-retour** : meilleures boucles A⇄B (une commodité à l'aller, une autre au
  retour) pour ne jamais repartir à vide.
- Filtre **commodités légales uniquement** (exclut la contrebande / le risque de scan).
- **Fiabilité des données** : âge de chaque relevé UEX (pastille colorée) + filtre par fraîcheur
  (< 24 h / < 3 j / < 7 j), point de statut d'inventaire coloré (stock à l'achat / demande à la
  vente), et tag **« à vérifier »** sur les relevés > 10 jours ou aux prix aberrants vs moyenne UEX.
- Filtres : commodité, système d'achat, « même système uniquement » (routes sans saut),
  « exclure les avant-postes » (élévateurs de fret peu fiables — garde stations et villes),
  et « limiter au stock & à la demande UEX » (plafonne les unités par le stock dispo à l'achat
  ET la demande à la vente ; relevés souvent périmés, donc désactivé par défaut).
- Repère les sauts inter-systèmes (Stanton ↔ Pyro).

## Déploiement (une seule fois)

Le workflow **construit les données puis publie le site entier** (données fraîches
comprises) comme artefact GitHub Pages. Les JSON ne sont plus commités dans le dépôt,
donc l'historique git ne gonfle pas.

1. Crée un dépôt GitHub et pousse ces fichiers sur la branche `main`.
2. **Settings → Pages** → Source : **`GitHub Actions`** (⚠️ *pas* `Deploy from a branch` —
   le workflow échouera tant que ce réglage n'est pas sur `GitHub Actions`).
3. Onglet **Actions** → lance *Mise à jour des routes UEX* manuellement une première fois.
4. Le site est en ligne sur `https://<ton-pseudo>.github.io/<nom-du-repo>/`.

Ensuite, le site se reconstruit et se redéploie toutes les heures (données rafraîchies),
et à chaque push sur `main`. En cas d'échec, une issue est ouverte automatiquement
(et refermée au retour à la normale).

## Lancer en local

```bash
npm test                         # tests des fonctions de calcul (node --test)
npm run build                    # régénère data/*.json (ou: node scripts/build-data.mjs)
npx serve .                      # ou: python -m http.server
```

Ouvre l'URL indiquée (ne pas ouvrir `index.html` en `file://` — `fetch` a besoin d'un serveur).
Les `data/*.json` versionnés servent d'amorce pour le dev local ; en production, le workflow
en génère toujours une version fraîche avant de publier.

## Personnalisation

- Fréquence de mise à jour : le `cron` dans [`.github/workflows/update-data.yml`](.github/workflows/update-data.yml).
- Nombre de routes / ventes candidates : `MAX_ROUTES` et `TOP_SELLS` dans
  [`scripts/build-data.mjs`](scripts/build-data.mjs).

## Sources de données alternatives / complémentaires

- **UEX Corp** (utilisé ici) — la plus complète, API publique, données communautaires.
- **SC Trade Tools** (`sc-trade.tools`) — routes optimisées, mais pas d'API publique documentée.
- **Regolith Co** — plutôt orienté minage/raffinage.
- **API SC officielle (RSI)** — pas d'API de prix marché ; le marché in-game n'est pas exposé.

UEX reste la meilleure source unique pour cet usage.

---

Non affilié à Cloud Imperium Games. Les prix et stocks in-game varient : vérifie avant de voler.
