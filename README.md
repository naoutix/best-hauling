# Best Hauling — Routes commerciales Star Citizen

Site statique qui affiche les meilleures routes d'arbitrage de commodités dans Star Citizen.
Les données viennent de l'[API publique UEX Corp](https://uexcorp.space/api/documentation/)
(lecture sans token) et sont rafraîchies automatiquement par GitHub Actions.

## Comment ça marche

```
GitHub Actions (cron horaire)
   └─ node scripts/build-data.mjs
        ├─ GET api.uexcorp.uk/2.0/terminals?type=commodity
        ├─ GET api.uexcorp.uk/2.0/commodities_prices_all
        ├─ calcule les meilleures routes (achat le moins cher → vente la plus chère)
        └─ écrit data/routes.json + data/meta.json  → commit
                                   │
GitHub Pages (page statique)  ────┘
   └─ index.html + app.js chargent data/routes.json
        └─ calcul du profit/voyage selon ta soute (SCU) et ton budget (aUEC)
```

Pas de serveur, pas de clé API, pas de coût.

## Fonctionnalités

- Liste triable : profit/voyage, marge/SCU, ROI, unités, commodité.
- Entrées **capacité de soute (SCU)** et **budget (aUEC)** → profit réel par voyage.
- Filtres : commodité, système d'achat, « même système uniquement » (routes sans saut),
  et « limiter au stock UEX » (le stock in-game étant souvent périmé, désactivé par défaut).
- Repère les sauts inter-systèmes (Stanton ↔ Pyro).

## Déploiement (une seule fois)

1. Crée un dépôt GitHub et pousse ces fichiers sur la branche `main`.
2. **Settings → Pages** → Source : `Deploy from a branch`, branche `main`, dossier `/ (root)`.
3. **Settings → Actions → General → Workflow permissions** → coche
   *Read and write permissions* (pour que le bot puisse commit les données).
4. Onglet **Actions** → lance *Mise à jour des routes UEX* manuellement une première fois.
5. Le site est en ligne sur `https://<ton-pseudo>.github.io/<nom-du-repo>/`.

Ensuite, les données se mettent à jour toutes les heures automatiquement.

## Lancer en local

```bash
node scripts/build-data.mjs      # génère data/routes.json
npx serve .                      # ou: python -m http.server
```

Ouvre l'URL indiquée (ne pas ouvrir `index.html` en `file://` — `fetch` a besoin d'un serveur).

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
