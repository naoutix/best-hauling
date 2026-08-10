# Mode « Butin » (onglet Commodités) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une bascule Marché / Butin à l'onglet Commodités qui répond à « j'ai trouvé cette ressource, elle vaut combien et où je l'écoule ? », en faisant d'abord entrer dans les données les 36 commodités UEX qu'on peut vendre sans pouvoir les acheter.

**Architecture:** Le pipeline (`scripts/build-data.mjs`) élargit son critère d'inclusion de « échangeable » (achat ET vente) à « vendable » (vente). Les commodités sans point d'achat sont inertes pour toutes les vues de trading, qui partent toutes d'un achat. Côté front, un état `commBoard` (`"market"` | `"loot"`) change la valeur affichée sur les tuiles (marge → prix de revente), leur coloration (linéaire → par rang) et le panneau de détail (deux colonnes → « où l'écouler »). Tout calcul reste pur dans `logic.mjs`, tout rendu dans `app.js`.

**Tech Stack:** JavaScript ES modules, zéro dépendance à l'exécution. Tests : `node --test` (unitaires) et Playwright (E2E, dev uniquement).

**Spec:** `docs/superpowers/specs/2026-08-10-mode-butin-commodites-design.md`

## Global Constraints

- **Node >= 20** (`package.json` → `engines`), `fetch` natif, pas de transpilation.
- **Zéro dépendance à l'exécution.** Playwright est une devDependency ; le site livré n'embarque rien.
- **Séparation stricte** : les fonctions de calcul **pures** vont dans `logic.mjs` (importées par `app.js` *et* par les tests) ; `app.js` ne fait que rendu DOM, état et câblage. Ne jamais mettre de logique testable dans `app.js`.
- **Langue** : toute l'interface et **tous les commentaires de code** sont en français, comme le reste du dépôt.
- **Style de commentaires** : le dépôt commente le *pourquoi* (pièges, sémantique UEX, raisons d'un choix), pas le *quoi*. Suivre cette densité.
- **Commits** : messages en français, préfixe conventionnel (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- **Ne PAS toucher** au numéro de cache du service worker (`sw.js`, `best-hauling-v4`). La coquille est servie en *stale-while-revalidate* et se met à jour seule ; aucun fichier n'est ajouté à `SHELL`. Un bump forcerait un re-téléchargement complet sans bénéfice.
- **Valeurs exactes des paliers de rang** (mode Butin) : `< 15 %` → `t-hot`, `< 40 %` → `t-warm`, `< 70 %` → `t-mid`, sinon `t-low`.
- **Clé d'état du permalien** : `cb`, valeur `"loot"` (absente en mode Marché).

## Structure des fichiers

| Fichier | Responsabilité après changement |
|---|---|
| `scripts/build-data.mjs` | `buildMarket()` retient tout ce qui est vendable (une ligne) |
| `scripts/build-data.test.mjs` | prouve l'inclusion du butin **et** son innocuité (ni route, ni segment) |
| `logic.mjs` | `commoditySummaries()` gagne `sellOnly` + l'option `board` ; nouvelle fonction pure `valueTiers()` |
| `logic.test.mjs` | couvre les deux |
| `index.html` | segmenté Marché/Butin dans `#commoditiesControls`, `id` sur le texte d'aide |
| `app.js` | état `commBoard`, tri, tuiles, détail, persistance |
| `style.css` | tuile « vente seule », colonne unique, en-tête de valeur |
| `e2e/smoke.pw.mjs` | non-régression UI des trois comportements clés |
| `README.md` | tableau des vues |
| `data/*.json` | amorce régénérée (contient enfin le butin) |

---

### Task 1: Pipeline — faire entrer les commodités « vente seule » dans `market.json`

**Files:**
- Modify: `scripts/build-data.mjs:183`
- Test: `scripts/build-data.test.mjs`

**Interfaces:**
- Consumes: rien (première tâche).
- Produces: `buildMarket(byCommodity, term)` renvoie désormais aussi les commodités dont `buys` est vide. La forme de sortie est inchangée : `{ terminals: [{name, system, planet, outpost}], commodities: [{name, code, kind, illegal, buys, sells}] }` où chaque `buy`/`sell` est le tuple `[idxTerminal, prix, volume, maj, statut]`. Une commodité « vente seule » a `buys: []`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `scripts/build-data.test.mjs` (le helper `buy` existe déjà en haut du fichier, ligne 18 — ne pas le redéfinir) :

```javascript
test("buildMarket garde les commodités « vente seule » (butin : minage, salvage, wreck)", () => {
  const term = new Map([
    [10, { name: "A", system: "Stanton", planet: "Hurston", outpost: false }],
    [20, { name: "B", system: "Pyro", planet: "", outpost: true }],
  ]);
  const byCommodity = new Map([
    // Quantainium : on le mine, on ne l'achète nulle part -> aucun point d'achat.
    [1, {
      name: "Quantainium", code: "QUAN", kind: "mineral", illegal: false,
      buys: [],
      sells: [buy({ id: 20, price: 170000, demand: 0, updated: 333, status: 1 })],
    }],
  ]);
  const m = buildMarket(byCommodity, term);
  assert.equal(m.commodities.length, 1);
  assert.deepEqual(m.commodities[0].buys, []);
  assert.deepEqual(m.commodities[0].sells[0], [0, 170000, 0, 333, 1]);
  assert.equal(m.commodities[0].code, "QUAN");
});

test("une commodité sans vente reste écartée (rien à en faire)", () => {
  const term = new Map([[10, { name: "A", system: "Stanton", planet: "", outpost: false }]]);
  const byCommodity = new Map([
    [1, { name: "X", kind: "gas", illegal: false, buys: [buy({ id: 10, price: 10 })], sells: [] }],
  ]);
  assert.equal(buildMarket(byCommodity, term).commodities.length, 0);
});

test("une commodité « vente seule » ne produit ni route ni segment (inerte pour le trading)", () => {
  const c = {
    name: "Quantainium", kind: "mineral", illegal: false, refBuy: 0, refSell: 170000,
    buys: [],
    sells: [buy({ id: 20, name: "B", system: "Pyro", price: 170000 })],
  };
  assert.deepEqual(routesForCommodity(c), []);
  const legs = buildBestLegs(new Map([[1, c]]));
  assert.equal(legs.size, 0);
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test`
Expected: FAIL sur « buildMarket garde les commodités « vente seule » » avec `AssertionError: 0 !== 1` (la commodité est écartée par le critère actuel). Les deux autres tests passent déjà — c'est normal et voulu : ils verrouillent le comportement à ne PAS casser.

- [ ] **Step 3: Élargir le critère d'inclusion**

Dans `scripts/build-data.mjs`, remplacer la ligne 183 :

```javascript
    if (!c.buys.length || !c.sells.length) continue; // uniquement les commodités échangeables
```

par :

```javascript
    // Tout ce qui est VENDABLE entre, même sans point d'achat : le butin (minerais raffinés,
    // salvage, drogues de wreck) ne s'achète nulle part et c'est justement ce que le mode
    // « Butin » de l'onglet Commodités doit pouvoir chiffrer. Sans vente, il n'y a rien à en dire.
    // Ces commodités restent inertes pour Trajets/Boucles/En route/Chaîne, qui partent toutes
    // d'un point d'achat (`c.buys.find(...)`) et n'en trouvent aucun.
    if (!c.sells.length) continue;
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test`
Expected: PASS, y compris le test existant « buildMarket déduplique les terminaux et compacte achats/ventes en tuples » qui vérifie toujours qu'une commodité sans vente est écartée.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-data.mjs scripts/build-data.test.mjs
git commit -m "feat(data): market.json accueille les commodités vendables sans point d'achat"
```

---

### Task 2: Régénérer les données d'amorce

**Files:**
- Modify: `data/market.json`, `data/routes.json`, `data/loops.json`, `data/meta.json` (générés)

**Interfaces:**
- Consumes: `buildMarket` élargi (Task 1).
- Produces: un `data/market.json` local contenant des commodités à `buys: []` — indispensable pour développer et tester la suite (le E2E de la Task 8 en dépend).

- [ ] **Step 1: Régénérer**

Run: `npm run build`
Expected: le script interroge UEX (réseau requis) et réécrit `data/*.json`. Compter quelques minutes (calcul des distances).

> Si UEX est indisponible, ne pas bricoler un jeu de données à la main : arrêter ici, signaler, et reprendre plus tard. Le reste du plan dépend de données réelles.

- [ ] **Step 2: Vérifier que le butin est bien entré**

Run:
```bash
node -e "const j=JSON.parse(require('fs').readFileSync('data/market.json','utf8'));const s=j.commodities.filter(c=>!c.buys.length);console.log('commodités vente seule :',s.length);console.log(s.slice(0,8).map(c=>'  '+c.code+' '+c.name).join('\n'));"
```
Expected: un nombre **strictement supérieur à 0** (~36 au 2026-08-10), avec des noms du type `QUAN Quantainium`, `HADA Hadanite`, `SLAM SLAM`.

- [ ] **Step 3: Vérifier la non-régression des routes**

Run: `npm test`
Expected: PASS. Puis vérifier que `data/routes.json` n'a pas perdu de routes :
```bash
node -e "const m=JSON.parse(require('fs').readFileSync('data/meta.json','utf8'));console.log(m);"
```
Expected: `routes` et `loops` du même ordre de grandeur qu'avant (les compteurs bougent avec les prix UEX, mais pas d'effondrement à 0) ; `commodities` a augmenté.

- [ ] **Step 4: Commit**

```bash
git add data
git commit -m "chore(data): régénère l'amorce (contient désormais le butin)"
```

---

### Task 3: `commoditySummaries` — champ `sellOnly` et option `board`

**Files:**
- Modify: `logic.mjs:546-568`
- Test: `logic.test.mjs`

**Interfaces:**
- Consumes: la forme `market` produite par la Task 1.
- Produces: `commoditySummaries(market, f)` où `f = { legalOnly?, noOutpost?, board? }`, `board` valant `"market"` (défaut) ou `"loot"`. Chaque ligne renvoyée garde ses champs actuels (`name, code, kind, illegal, nBuy, nSell, bestBuy, bestSell, buyStatus, sellStatus, margin`) et gagne **`sellOnly: boolean`**.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `logic.test.mjs`, à la suite des tests `commoditySummaries` existants. Le marché de test est local au test (ne pas réutiliser un fixture d'un autre test) :

```javascript
// Marché de test : une commodité échangeable, une « vente seule » (butin), une achetable
// uniquement en avant-poste (piège du filtre noOutpost).
const MARKET_BUTIN = {
  terminals: [
    { name: "Ville", system: "Stanton", planet: "Hurston", outpost: false },
    { name: "Poste", system: "Stanton", planet: "Hurston", outpost: true },
  ],
  commodities: [
    { name: "Laranite", code: "LARA", kind: "metal", illegal: false,
      buys: [[0, 100, 50, 1, 3]], sells: [[0, 250, 80, 1, 2]] },
    { name: "Quantainium", code: "QUAN", kind: "mineral", illegal: false,
      buys: [], sells: [[0, 170000, 0, 1, 1]] },
    { name: "Stims", code: "STIM", kind: "drug", illegal: false,
      buys: [[1, 10, 5, 1, 3]], sells: [[0, 40, 9, 1, 2]] },
  ],
};

test("commoditySummaries : mode Marché (défaut) ignore les commodités sans point d'achat", () => {
  const rows = commoditySummaries(MARKET_BUTIN);
  assert.deepEqual(rows.map((r) => r.name), ["Laranite", "Stims"]);
  assert.equal(rows.every((r) => r.sellOnly === false), true);
});

test("commoditySummaries : mode Butin ajoute le butin et chiffre sa revente", () => {
  const rows = commoditySummaries(MARKET_BUTIN, { board: "loot" });
  assert.deepEqual(rows.map((r) => r.name), ["Laranite", "Quantainium", "Stims"]);
  const quan = rows.find((r) => r.name === "Quantainium");
  assert.equal(quan.sellOnly, true);
  assert.equal(quan.bestSell, 170000);
  assert.equal(quan.bestBuy, null);
  assert.equal(quan.margin, null); // pas de marge sans achat
  assert.equal(quan.nBuy, 0);
});

test("commoditySummaries : `sellOnly` se juge sur les données brutes, pas après le filtre avant-postes", () => {
  // Stims ne s'achète qu'en avant-poste : exclure les avant-postes ne doit PAS le faire
  // basculer en « butin » ni le sortir du board Marché (régression évitée).
  const rows = commoditySummaries(MARKET_BUTIN, { noOutpost: true });
  const stims = rows.find((r) => r.name === "Stims");
  assert.ok(stims, "Stims reste listé en mode Marché");
  assert.equal(stims.sellOnly, false);
  assert.equal(stims.bestBuy, null); // son seul achat est filtré
  assert.equal(stims.nBuy, 0);
});

test("commoditySummaries : mode Butin retire ce qui n'a plus aucun point de vente après filtrage", () => {
  const market = {
    terminals: [{ name: "Poste", system: "Pyro", planet: "", outpost: true }],
    commodities: [{ name: "Riccite", code: "RICC", kind: "mineral", illegal: false, buys: [], sells: [[0, 91000, 0, 1, 1]] }],
  };
  assert.equal(commoditySummaries(market, { board: "loot" }).length, 1);
  assert.equal(commoditySummaries(market, { board: "loot", noOutpost: true }).length, 0);
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test`
Expected: FAIL — le premier test échoue car `Quantainium` est listé alors qu'il ne devrait pas ; `sellOnly` est `undefined`.

- [ ] **Step 3: Implémenter**

Dans `logic.mjs`, remplacer le bloc `commoditySummaries` (lignes 546-568, commentaire d'en-tête compris) par :

```javascript
// ---------- Panneau « Commodités » : résumé global + points d'achat/vente ----------
// Une ligne de synthèse par commodité (pour le grand tableau triable).
// f (optionnel) = { legalOnly, noOutpost, board } :
//   - legalOnly / noOutpost : masque les commodités illégales, exclut les points en avant-poste
//     du calcul best/compteurs ;
//   - board = "market" (défaut) -> uniquement les commodités ÉCHANGEABLES (achat ET vente) ;
//     board = "loot" -> mode Butin : tout ce qui se VEND, y compris ce qu'on ne peut acheter
//     nulle part (minerais raffinés, salvage, drogues de wreck) — le cas « je l'ai trouvé ».
export function commoditySummaries(market, f = {}) {
  const loot = f.board === "loot";
  const out = [];
  for (const c of market.commodities) {
    if (f.legalOnly && c.illegal) continue;
    // « Échangeable » se juge sur les données BRUTES : le juger après `noOutpost` ferait
    // disparaître du board Marché une commodité achetable seulement en avant-poste.
    const sellOnly = c.buys.length === 0;
    if (!loot && sellOnly) continue;
    const buys = f.noOutpost ? c.buys.filter((b) => !market.terminals[b[0]].outpost) : c.buys;
    const sells = f.noOutpost ? c.sells.filter((s) => !market.terminals[s[0]].outpost) : c.sells;
    // Achat le moins cher / vente la plus chère + le statut d'inventaire à ce point.
    let bestBuy = null, buyStatus = 0;
    for (const b of buys) if (bestBuy == null || b[1] < bestBuy) { bestBuy = b[1]; buyStatus = b[4] || 0; }
    let bestSell = null, sellStatus = 0;
    for (const s of sells) if (bestSell == null || s[1] > bestSell) { bestSell = s[1]; sellStatus = s[4] || 0; }
    // En mode Butin, une commodité sans point de vente restant n'a plus de réponse à offrir.
    if (loot && bestSell == null) continue;
    const margin = bestBuy != null && bestSell != null ? bestSell - bestBuy : null;
    out.push({
      name: c.name, code: c.code || "", kind: c.kind, illegal: c.illegal,
      nBuy: buys.length, nSell: sells.length, bestBuy, bestSell, buyStatus, sellStatus, margin,
      sellOnly,
    });
  }
  return out;
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test`
Expected: PASS, tests existants compris.

- [ ] **Step 5: Commit**

```bash
git add logic.mjs logic.test.mjs
git commit -m "feat(logic): commoditySummaries distingue le butin du marché échangeable"
```

---

### Task 4: `valueTiers` — heatmap par rang

**Files:**
- Modify: `logic.mjs` (ajouter après `commodityPoints`, avant `compactValue`)
- Test: `logic.test.mjs`

**Interfaces:**
- Consumes: les lignes produites par `commoditySummaries` (Task 3).
- Produces: `valueTiers(rows, key = "bestSell")` → `Map<string, string>` associant `row.name` à une classe CSS parmi `"t-hot" | "t-warm" | "t-mid" | "t-low" | "t-none"`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter `valueTiers` à la liste d'imports en tête de `logic.test.mjs` (sur la ligne qui importe déjà `commoditySummaries, commodityPoints, compactValue`), puis ajouter les tests :

```javascript
// ---------- Heatmap par rang (mode Butin) ----------
const rowsOf = (vals) => vals.map((v, i) => ({ name: "C" + i, bestSell: v }));

test("valueTiers répartit par rang : 15 % / 25 % / 30 % / reste", () => {
  const t = valueTiers(rowsOf([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]));
  assert.deepEqual([...t.values()], [
    "t-hot", "t-hot", "t-warm", "t-warm", "t-mid", "t-mid", "t-mid", "t-low", "t-low", "t-low",
  ]);
});

test("valueTiers résiste aux valeurs extrêmes (Saldynium à 34 M vs Iron Ore à 1 000)", () => {
  // C'est tout l'intérêt du rang : une échelle linéaire écraserait les trois derniers en t-low.
  const t = valueTiers(rowsOf([34_000_000, 1000, 900, 800]));
  assert.deepEqual([...t.values()], ["t-hot", "t-warm", "t-mid", "t-low"]);
});

test("valueTiers est indépendant de l'ordre d'affichage (tri par code ≠ recoloration)", () => {
  const desc = valueTiers([{ name: "A", bestSell: 300 }, { name: "B", bestSell: 200 }, { name: "C", bestSell: 100 }]);
  const asc = valueTiers([{ name: "C", bestSell: 100 }, { name: "B", bestSell: 200 }, { name: "A", bestSell: 300 }]);
  assert.equal(asc.get("A"), desc.get("A"));
  assert.equal(asc.get("B"), desc.get("B"));
  assert.equal(asc.get("C"), desc.get("C"));
});

test("valueTiers : valeur absente -> t-none, et elle ne décale pas les rangs", () => {
  const t = valueTiers([{ name: "Vide", bestSell: null }, ...rowsOf([100, 50])]);
  assert.equal(t.get("Vide"), "t-none");
  assert.equal(t.get("C0"), "t-hot");
  assert.equal(t.get("C1"), "t-mid"); // 2 valeurs : rangs 0 (0 %) et 1 (50 %)
});

test("valueTiers : une seule commodité est en tête", () => {
  assert.equal(valueTiers(rowsOf([42])).get("C0"), "t-hot");
  assert.equal(valueTiers([]).size, 0);
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test`
Expected: FAIL avec `SyntaxError` ou `valueTiers is not a function` (l'export n'existe pas).

- [ ] **Step 3: Implémenter**

Dans `logic.mjs`, insérer juste avant `// Notation compacte K/M pour les tuiles du board` :

```javascript
// Paliers de heatmap par RANG, pour le mode « Butin ».
// Les prix de revente s'étalent sur cinq ordres de grandeur (Saldynium à 34 M aUEC/SCU contre
// Iron Ore à 1 000) : une échelle relative au maximum, comme `marginTier`, tasserait tout le
// board dans le palier le plus bas sauf deux tuiles. Le rang, lui, colore toujours.
// Le classement se fait sur la VALEUR, jamais sur l'ordre d'affichage : trier par code A→Z ne
// doit pas recolorer le board. À valeur égale, l'ordre est celui du tri (stable).
export function valueTiers(rows, key = "bestSell") {
  const tiers = new Map();
  const ranked = [];
  for (const r of rows) {
    if (r[key] == null) tiers.set(r.name, "t-none"); // rien à classer -> hors barème
    else ranked.push(r);
  }
  ranked.sort((a, b) => b[key] - a[key]);
  const n = ranked.length;
  ranked.forEach((r, i) => {
    const q = i / n; // part des commodités strictement mieux payées
    tiers.set(r.name, q < 0.15 ? "t-hot" : q < 0.40 ? "t-warm" : q < 0.70 ? "t-mid" : "t-low");
  });
  return tiers;
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add logic.mjs logic.test.mjs
git commit -m "feat(logic): valueTiers, heatmap par rang pour les prix de revente"
```

---

### Task 5: Le segmenté Marché / Butin (HTML, style, board)

**Files:**
- Modify: `index.html:169-179`
- Modify: `style.css` (section « Vue Commodités », après la ligne `.comm-tile.carried`)
- Modify: `app.js:10` (import), `app.js:35` (état), `app.js:1528-1535` (tri), `app.js:1562-1575` (tuile), `app.js:1596-1616` (rendu), `app.js:1647-1658` (câblage)

**Interfaces:**
- Consumes: `commoditySummaries(market, { …filtres, board })` et `valueTiers(rows)` (Tasks 3 et 4).
- Produces: variable de module `commBoard` (`"market"` | `"loot"`) et fonction `syncCommBoardUI()` dans `app.js`, réutilisées par les Tasks 6 et 7. Boutons DOM : `#commBoardModes button[data-board="market"|"loot"]`. Classe CSS `.comm-tile.sell-only` sur les tuiles introuvables à l'achat.

- [ ] **Step 1: Ajouter le segmenté et l'`id` du texte d'aide**

Dans `index.html`, remplacer le bloc `<section id="commoditiesControls">` (lignes 169-179) par :

```html
        <section id="commoditiesControls" class="enroute-controls" hidden>
          <div class="field">
            <label>Mode</label>
            <div class="sort-modes" id="commBoardModes">
              <button type="button" data-board="market" class="active" title="Board de marché : marge achat → vente">◈ Marché</button>
              <button type="button" data-board="loot" title="Butin : prix de revente d'une ressource trouvée (minage, salvage, wreck)">💰 Butin</button>
            </div>
          </div>
          <div class="field">
            <label>Trier le board par</label>
            <div class="sort-modes" id="commSortModes">
              <button type="button" data-sort="margin" class="active">Marge</button>
              <button type="button" data-sort="code">Code A→Z</button>
              <button type="button" data-sort="kind">Catégorie</button>
            </div>
          </div>
          <p class="enroute-hint" id="commHint">Le <b>board de marché</b> : chaque tuile = une commodité (code UEX) et sa <b>marge max</b>, colorée selon son intérêt. Clique une tuile — ou cherche via le champ <b>Commodité</b> — pour voir <b>tous ses points d'achat / vente</b> (stock, demande, prix) et surtout <b>où l'écouler</b> quand une station est saturée.</p>
        </section>
```

- [ ] **Step 2: Ajouter le style de la tuile « vente seule »**

Dans `style.css`, juste après la ligne `.comm-tile.carried { … }` (ligne 682) :

```css
/* Mode Butin : introuvable à l'achat (minage, salvage, wreck) -> contour pointillé. */
.comm-tile.sell-only { border-style: dashed; }
```

- [ ] **Step 3: Écrire l'état, le tri et le rendu dans `app.js`**

3a. Ligne 10, ajouter `valueTiers` à l'import depuis `./logic.mjs` (la ligne devient) :

```javascript
  commoditySummaries, commodityPoints, compactValue, valueTiers,
```

3b. Ligne 35, ajouter les deux variables de module à la suite de la ligne existante :

```javascript
let commMode = "margin", commSortKey = "margin", commSortDir = -1, commSelected = null, shownCommodities = [];
// Board « Commodités » : "market" = marge achat→vente ; "loot" = prix de revente d'une ressource
// trouvée (le coût d'acquisition est nul, la marge n'a plus de sens).
let commBoard = "market", commTiers = new Map();
```

3c. Remplacer `sortCommodities` (le corps aux lignes 1528-1535) par cette version, qui trie sur la valeur du board courant :

```javascript
function sortCommodities(rows) {
  // La « valeur » d'une tuile dépend du board : marge en Marché, prix de revente en Butin.
  const vk = commBoard === "loot" ? "bestSell" : "margin";
  if (commMode === "margin") return rows.sort(bySort(vk, -1));                        // plus lucratif d'abord
  if (commMode === "code") return rows.sort(bySort("code", 1));                        // code A→Z
  if (commMode === "kind")                                                             // catégorie puis valeur
    return rows.sort((a, b) => (a.kind || "").localeCompare(b.kind || "", "fr") || (b[vk] ?? -Infinity) - (a[vk] ?? -Infinity));
  return rows.sort(bySort(commSortKey, commSortDir));                                  // colonne (mode custom)
}
```

3d. Remplacer `commodityTileHTML` (lignes 1562-1575) par :

```javascript
// Une tuile du board : code UEX + valeur compacte (K/M), colorée par palier.
// En Marché la valeur est la marge (heatmap linéaire) ; en Butin le prix de revente
// (heatmap par rang, cf. valueTiers — les prix s'étalent sur cinq ordres de grandeur).
function commodityTileHTML(c) {
  const loot = commBoard === "loot";
  const val = loot ? c.bestSell : c.margin;
  const tier = loot ? commTiers.get(c.name) || "t-none" : marginTier(c.margin);
  const carried = commCarried.has(c.name);
  const cls = [
    "comm-tile", tier,
    c.name === commSelected ? "selected" : "",
    c.illegal ? "illegal" : "",
    carried ? "carried" : "",
    loot && c.sellOnly ? "sell-only" : "",
  ].filter(Boolean).join(" ");
  const title = loot
    ? `${c.name}${c.illegal ? " (illégal)" : ""} — revente max ${fmt(c.bestSell)} aUEC/SCU · ${c.nSell} point(s) de vente${c.sellOnly ? " · introuvable à l'achat — butin / minage" : ""}`
    : `${c.name}${c.illegal ? " (illégal)" : ""}${carried ? " — transportée dans ton voyage" : ""} — marge max ${fmt(c.margin)} aUEC/SCU · ${c.nBuy} achat(s) / ${c.nSell} vente(s)`;
  return `<button class="${cls}" data-name="${esc(c.name)}" title="${esc(title)}">
      <span class="tile-code">${carried ? '<span class="tile-carried" title="Dans ton voyage">◆</span>' : ""}${esc(c.code || c.name.slice(0, 4).toUpperCase())}</span>
      <span class="tile-val">${val == null ? "—" : compactValue(val)}</span>
    </button>`;
}
```

3e. Dans `renderCommodities` (lignes 1596-1616), passer le board aux filtres et calculer les paliers. Remplacer les lignes qui vont de `const f = readFilters();` jusqu'à `commCarried = journeyCarriedCommodities();` par :

```javascript
  const f = { ...readFilters(), board: commBoard };
  const q = f.q;
  let rows = commoditySummaries(MARKET, f).filter( // légales + avant-postes + board s'appliquent ici
    (c) => !q || c.name.toLowerCase().includes(q) || (c.code && c.code.toLowerCase().includes(q))
  );
  sortCommodities(rows);
  shownCommodities = rows;
  commMaxMargin = rows.reduce((mx, c) => Math.max(mx, c.margin || 0), 0); // heatmap relative (Marché)
  commTiers = commBoard === "loot" ? valueTiers(rows) : new Map();        // heatmap par rang (Butin)
  commCarried = journeyCarriedCommodities(); // commodités du voyage à surligner
```

3f. Toujours dans `renderCommodities`, juste après la ligne `document.querySelectorAll("#commSortModes button").forEach(...)`, ajouter :

```javascript
  syncCommBoardUI();
```

3g. Ajouter `syncCommBoardUI` et `setCommBoard` juste au-dessus de `function renderCommodities()` :

```javascript
// Textes d'aide : le board ne répond pas à la même question selon le mode.
const COMM_HINT_MARKET = 'Le <b>board de marché</b> : chaque tuile = une commodité (code UEX) et sa <b>marge max</b>, colorée selon son intérêt. Clique une tuile — ou cherche via le champ <b>Commodité</b> — pour voir <b>tous ses points d\'achat / vente</b> (stock, demande, prix) et surtout <b>où l\'écouler</b> quand une station est saturée.';
const COMM_HINT_LOOT = 'Tu as <b>trouvé</b> une ressource (minage, salvage, caisse abandonnée) ? Ce board liste <b>tout ce qui se vend</b>, y compris ce qui ne s\'achète nulle part, avec son <b>prix de revente max</b> au SCU. Clique une tuile pour voir <b>où l\'écouler</b>. Les tuiles en <b>pointillés</b> sont introuvables à l\'achat.';

// Reflète le board courant dans les contrôles. « Marge » n'a aucun sens quand l'acquisition est
// gratuite : le premier bouton de tri devient « Revente ».
function syncCommBoardUI() {
  const loot = commBoard === "loot";
  document.querySelectorAll("#commBoardModes button").forEach((b) => b.classList.toggle("active", b.dataset.board === commBoard));
  const first = document.querySelector('#commSortModes button[data-sort="margin"]');
  if (first) first.textContent = loot ? "Revente" : "Marge";
  $("commHint").innerHTML = loot ? COMM_HINT_LOOT : COMM_HINT_MARKET;
}

function setCommBoard(board) {
  if (board !== "market" && board !== "loot") return;
  if (board === commBoard) return;
  commBoard = board;
  renderCommodities(); // la sélection courante est revalidée par le rendu (elle peut disparaître)
  saveState();
}
```

3h. Dans `init()`, juste après la ligne qui câble `#commSortModes` (ligne 1650), ajouter :

```javascript
  $("commBoardModes").addEventListener("click", (e) => { const b = e.target.closest("button[data-board]"); if (b) setCommBoard(b.dataset.board); });
```

- [ ] **Step 4: Vérifier à l'œil dans le navigateur**

Run: `npm run serve` puis ouvrir `http://localhost:4173/index.html`, onglet **Commodités** (raccourci `6`).
Expected :
- En **Marché** : board identique à avant, bouton « Marge » actif, aucune tuile en pointillés.
- Clic sur **💰 Butin** : le board **grossit** (les commodités de butin apparaissent), le premier bouton de tri lit « Revente », les valeurs changent (prix de vente, pas marge), certaines tuiles sont en pointillés, et les couleurs restent **réparties** (pas un mur de gris malgré Saldynium à 34 M).
- Retour en **Marché** : board d'origine, plus aucune tuile pointillée.

- [ ] **Step 5: Lancer les tests**

Run: `npm test`
Expected: PASS (aucune régression sur les fonctions pures).

- [ ] **Step 6: Commit**

```bash
git add index.html style.css app.js
git commit -m "feat(ui): bascule Marché / Butin sur le board des commodités"
```

---

### Task 6: Panneau de détail en mode Butin

**Files:**
- Modify: `app.js:1577-1594` (`paintCommodityDetail`)
- Modify: `style.css` (section « Vue Commodités », après `.comm-cols`)

**Interfaces:**
- Consumes: `commBoard` (Task 5), `commodityPoints(market, name, f)` qui renvoie `{ name, code, kind, illegal, buys, sells }` où `sells` est **déjà trié par prix décroissant**.
- Produces: dans le DOM, `#commDetail .loot-value` (en-tête de valeur) et `#commDetail .comm-cols.one` (colonne unique) — ciblés par les tests E2E de la Task 8.

- [ ] **Step 1: Ajouter les styles**

Dans `style.css`, juste après la ligne `.comm-cols { … }` (ligne 699) :

```css
.comm-cols.one { grid-template-columns: 1fr; } /* mode Butin : pas de colonne « où acheter » */
/* Mode Butin : la réponse directe — combien vaut 1 SCU, et au meilleur endroit. */
.loot-value { margin-left: auto; text-align: right; font-family: var(--mono); font-size: 12px; color: var(--acc); }
.loot-value b { font-size: 16px; color: #fff; }
.loot-where { display: block; font-family: var(--font); font-size: 10.5px; color: var(--muted); letter-spacing: 0.3px; }
```

- [ ] **Step 2: Réécrire `paintCommodityDetail`**

Remplacer intégralement la fonction (lignes 1577-1594) par :

```javascript
// Mode Butin : la réponse directe à « ça vaut combien ». `p.sells` est déjà trié par prix
// décroissant, le meilleur point est donc en tête. Prix au SCU seulement — le joueur multiplie
// par ce qu'il a trouvé, on ne suppose pas une soute pleine.
function lootValueHTML(p) {
  const best = p.sells[0];
  if (!best) return '<span class="loot-value muted">aucun point de vente</span>';
  return `<span class="loot-value"><b>${fmt(best.price)}</b> aUEC/SCU<span class="loot-where">au mieux — ${esc(best.terminal)} (${esc(best.system)})</span></span>`;
}

// Détail d'une commodité : tous ses points d'achat (moins cher d'abord) et de vente (mieux payé
// d'abord). En mode Butin, l'achat n'a pas de sens : on ne garde que « où l'écouler ».
function paintCommodityDetail() {
  const box = $("commDetail");
  const loot = commBoard === "loot";
  if (!commSelected) {
    box.innerHTML = loot
      ? '<p class="manifest-hint">Sélectionne une commodité pour savoir combien elle vaut au SCU et où l\'écouler.</p>'
      : '<p class="manifest-hint">Sélectionne une commodité (ligne du tableau ou champ « Commodité ») pour voir tous ses points d\'achat et de vente.</p>';
    return;
  }
  const p = commodityPoints(MARKET, commSelected, readFilters()); // exclut les avant-postes si le filtre est actif
  if (!p) { box.innerHTML = ""; return; }
  const buyRow = (b) => `<tr><td class="loc"><div>${esc(b.terminal)}${sysBadge(b.system)}${outpostTag(b.outpost)}</div><div class="loc-sub">${esc(b.planet)}</div></td><td class="num">${fmt(b.price)}</td><td class="num">${statusDot(b.status, "buy")} ${fmt(b.stock)}</td><td>${freshChip(b.updated)}</td></tr>`;
  const sellRow = (s) => `<tr><td class="loc"><div>${esc(s.terminal)}${sysBadge(s.system)}${outpostTag(s.outpost)}</div><div class="loc-sub">${esc(s.planet)}</div></td><td class="num">${fmt(s.price)}</td><td class="num">${statusDot(s.status, "sell")} ${fmtVol(s.demand)}</td><td>${freshChip(s.updated)}</td></tr>`;
  const table = (rows, head, mapper) => rows.length
    ? `<table class="comm-points"><thead><tr><th>Terminal</th><th class="num">Prix</th><th class="num">${head}</th><th>Relevé</th></tr></thead><tbody>${rows.map(mapper).join("")}</tbody></table>`
    : '<p class="muted">Aucun point.</p>';
  const cols = loot
    ? `<div class="comm-cols one">
         <div class="comm-col"><h4>◈ Où l'écouler <span class="muted">(${p.sells.length} · mieux payé d'abord)</span></h4>${table(p.sells, "Demande", sellRow)}</div>
       </div>`
    : `<div class="comm-cols">
         <div class="comm-col"><h4>◈ Où acheter <span class="muted">(${p.buys.length} · moins cher d'abord)</span></h4>${table(p.buys, "Stock", buyRow)}</div>
         <div class="comm-col"><h4>◈ Où vendre <span class="muted">(${p.sells.length} · mieux payé d'abord)</span></h4>${table(p.sells, "Demande", sellRow)}</div>
       </div>`;
  box.innerHTML =
    `<div class="comm-detail-head">${commodityIcon(p.kind)}<span class="comm-detail-title">${p.code ? `<b class="comm-code">${esc(p.code)}</b> · ` : ""}${esc(p.name)}${illegalTag(p.illegal)}</span>${loot ? lootValueHTML(p) : ""}</div>
     ${cols}`;
}
```

- [ ] **Step 3: Vérifier à l'œil dans le navigateur**

Run: `npm run serve`, onglet Commodités → **💰 Butin** → cliquer une tuile en pointillés (ex. `QUAN`).
Expected :
- L'en-tête affiche le prix au SCU en gros et « au mieux — `<terminal>` (`<système>`) ».
- Une seule colonne, titrée « ◈ Où l'écouler ».
- Aucune colonne « Où acheter ».
- Retour en **Marché** : deux colonnes, pas d'en-tête de valeur.

- [ ] **Step 4: Lancer les tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app.js style.css
git commit -m "feat(ui): le détail en mode Butin ne montre que où écouler, prix au SCU en tête"
```

---

### Task 7: Persistance du mode (permalien + localStorage)

**Files:**
- Modify: `app.js:1373-1379` (`collectState`), `app.js:1407-1418` (`applyState`)

**Interfaces:**
- Consumes: `commBoard` et `syncCommBoardUI()` (Task 5).
- Produces: clé d'état `cb` (`"loot"` en mode Butin, absente sinon) dans l'URL et `localStorage`.

- [ ] **Step 1: Écrire l'état**

Dans `collectState()`, remplacer la ligne :

```javascript
  const s = { v: view, sk: sortKey, sd: sortDir, lk: loopSortKey, ld: loopSortDir };
```

par :

```javascript
  // `cb` : board des commodités. Vide en mode Marché (défaut) -> encodeState l'omet, l'URL reste courte.
  const s = { v: view, sk: sortKey, sd: sortDir, lk: loopSortKey, ld: loopSortDir, cb: commBoard === "loot" ? "loot" : "" };
```

- [ ] **Step 2: Relire l'état**

Dans `applyState(s)`, juste après la ligne `if (["routes", "loops", "enroute", "chain", "corrections", "commodities"].includes(s.v)) view = s.v;`, ajouter :

```javascript
  if (s.cb === "loot") commBoard = "loot";
```

et, juste après l'appel `syncToggles();` en fin de fonction, ajouter :

```javascript
  syncCommBoardUI(); // bouton actif + libellé « Revente » restaurés avant le premier rendu
```

- [ ] **Step 3: Vérifier à la main**

Run: `npm run serve`, onglet Commodités → **💰 Butin** → recharger la page (F5).
Expected : l'onglet Commodités revient en mode Butin, le bouton 💰 Butin est actif, le premier bouton de tri lit « Revente », et l'URL contient `cb=loot`.

- [ ] **Step 4: Lancer les tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat(ui): le mode Butin entre dans le permalien et le localStorage"
```

---

### Task 8: Tests E2E

**Files:**
- Modify: `e2e/smoke.pw.mjs` (ajouter à la fin)

**Interfaces:**
- Consumes: tout ce qui précède — `#commBoardModes`, `.comm-tile.sell-only`, `.loot-value`, `.comm-cols.one`, clé d'état `cb`.
- Produces: rien (feuille de l'arbre).

- [ ] **Step 1: Écrire les tests**

Ajouter à la fin de `e2e/smoke.pw.mjs` :

```javascript
test("mode Butin : le board expose les commodités qu'on ne peut pas acheter", async ({ page }) => {
  await page.click("#viewCommodities");
  await expect(page.locator("#commGrid .comm-tile").first()).toBeVisible();
  // Marché : que de l'échangeable, donc aucune tuile « introuvable à l'achat ».
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBe(0);
  const nMarket = await page.locator("#commGrid .comm-tile").count();

  await page.click('#commBoardModes button[data-board="loot"]');
  expect(await page.locator("#commGrid .comm-tile").count()).toBeGreaterThan(nMarket);
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBeGreaterThan(0);
  await expect(page.locator('#commSortModes button[data-sort="margin"]')).toHaveText("Revente");

  await page.click('#commBoardModes button[data-board="market"]');
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBe(0);
});

test("mode Butin : le détail ne montre que la revente", async ({ page }) => {
  await page.click("#viewCommodities");
  await page.click('#commBoardModes button[data-board="loot"]');
  await page.locator("#commGrid .comm-tile.sell-only").first().click();
  await expect(page.locator("#commDetail .loot-value")).toBeVisible();   // prix au SCU en tête
  await expect(page.locator("#commDetail .comm-col")).toHaveCount(1);    // une seule colonne
  await expect(page.locator("#commDetail")).toContainText("Où l'écouler");
  await expect(page.locator("#commDetail")).not.toContainText("Où acheter");

  // Retour en Marché : la sélection « butin » n'existe plus, le rendu retombe sur la 1re tuile.
  await page.click('#commBoardModes button[data-board="market"]');
  await expect(page.locator("#commDetail .comm-col")).toHaveCount(2);
  await expect(page.locator("#commDetail .loot-value")).toHaveCount(0);
});

test("le mode Butin survit au rechargement (permalien)", async ({ page }) => {
  await page.click("#viewCommodities");
  await page.click('#commBoardModes button[data-board="loot"]');
  await expect(page.locator('#commBoardModes button[data-board="loot"]')).toHaveClass(/active/);

  await page.reload();
  await expect(page.locator("#commGrid .comm-tile").first()).toBeVisible();
  await expect(page.locator('#commBoardModes button[data-board="loot"]')).toHaveClass(/active/);
  await expect(page.locator('#commSortModes button[data-sort="margin"]')).toHaveText("Revente");
  expect(await page.locator("#commGrid .comm-tile.sell-only").count()).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Lancer les E2E**

Run: `npm run e2e`
Expected: PASS. (Si Playwright n'est pas installé : `npm install && npx playwright install chromium`.)

> Ces trois tests dépendent de données contenant au moins une commodité « vente seule » — c'est ce que garantit la Task 2. S'ils échouent sur `sell-only ... 0`, c'est que `data/market.json` n'a pas été régénéré.

- [ ] **Step 3: Commit**

```bash
git add e2e/smoke.pw.mjs
git commit -m "test(e2e): non-régression du mode Butin (board, détail, permalien)"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md:33` (ligne « Commodités » du tableau des vues), `README.md:35-47` (liste « Autres éléments »)

**Interfaces:**
- Consumes: le comportement final.
- Produces: rien.

- [ ] **Step 1: Mettre à jour la ligne du tableau des vues**

Remplacer la ligne 33 du tableau par :

```markdown
| **Commodités 📊** | *Big board* type « salle des marchés », en deux modes. **◈ Marché** : toutes les commodités échangeables avec leur **code officiel UEX** (AGRI, QUAN…), triables (marge / code / catégorie), et au clic **tous leurs points d'achat et de vente** — pratique pour trouver **où écouler** une commodité quand une station n'a plus de demande. **💰 Butin** : le board bascule sur le **prix de revente au SCU** et fait entrer les commodités qu'on **ne peut pas acheter** (minerais raffinés, salvage, drogues de wreck) — la réponse à « j'ai trouvé ça, ça vaut combien et où je l'écoule ? » |
```

- [ ] **Step 2: Ajouter une puce à « Autres éléments »**

Juste après la puce **Multi commodité** (ligne 39), insérer :

```markdown
- **Mode Butin** (vue Commodités) : quand le coût d'acquisition est nul, la marge n'a plus de sens — seul compte le **prix de revente**. Ce mode liste **tout ce qui se vend** chez UEX, y compris les ~36 commodités sans aucun point d'achat, et n'affiche que **où l'écouler**. Sa heatmap se calcule **par rang** et non par ratio : les prix de revente s'étalent sur cinq ordres de grandeur (34 M aUEC/SCU pour le Saldynium contre 1 000 pour l'Iron Ore), une échelle linéaire écraserait tout le board.
```

- [ ] **Step 3: Corriger la note sur `market.json`**

Dans le tableau des fichiers de données (ligne 141), remplacer la cellule « Contenu » de `market.json` par :

```markdown
| `market.json` | Graphe d'échange compact (tous les points d'achat/vente, + **code UEX** par commodité). Contient **tout ce qui est vendable**, y compris les commodités sans point d'achat — inertes pour les vues de trading, exploitées par le mode **Butin** |
```

- [ ] **Step 4: Relire**

Run: ouvrir `README.md` et vérifier que les tableaux restent bien formés (pas de `|` orphelin).
Expected: rendu correct.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: documente le mode Butin de l'onglet Commodités"
```

---

## Vérification finale

- [ ] `npm test` — PASS
- [ ] `npm run e2e` — PASS
- [ ] `npm run serve` : bascule Marché ↔ Butin, sélection d'une tuile pointillée, rechargement — conformes aux attentes des Tasks 5 à 7.
