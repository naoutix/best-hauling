// Batterie de tests des fonctions de calcul pures (app.js s'appuie dessus).
// Lancer : `node --test` (ou `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tripMinutes, loopMinutes, ageDays, pairAge, freshnessFactor, availabilityFactor,
  normalizeScores, bySort, computeUnits, effValue, fillCargo, addableUnits, scuBoxes, bestChain,
  ovKey, effFromStore, setInStore, safeKey, encodeState, decodeState,
  profitPerHour, rawScoreOf, routePasses, loopPasses,
  routeMetrics, loopMetrics, dealFrom, enRouteDeals, bestManifest, buildChainAdjacency,
  commoditySummaries, commodityPoints, compactValue,
  legFromRoute, legsFromLoop, legsFromChain, startJourney, startJourneyAt, journeyStations, journeyEnd,
  journeyConnects, addToJourney, setJourneyPosition, currentLeg, journeyMargin,
  encodeJourney, decodeJourney,
} from "./logic.mjs";

// ---------- Temps de trajet ----------
test("tripMinutes : manutention + distance + saut inter-système", () => {
  assert.equal(tripMinutes(0, false), 6);          // 2*3
  assert.equal(tripMinutes(100, false), 12);        // 6 + 100*0.06
  assert.equal(tripMinutes(100, true), 16);         // + JUMP 4
  assert.equal(tripMinutes(null, false), 6);        // distance nulle tolérée
});

test("loopMinutes : double manutention + double saut", () => {
  assert.equal(loopMinutes(0, false), 12);          // 4*3
  assert.equal(loopMinutes(100, true), 12 + 6 + 8); // 4*3 + 100*0.06 + 2*4
});

test("tripMinutes/loopMinutes ne sont jamais nuls (pas de division par zéro en aval)", () => {
  assert.ok(tripMinutes(0, false) >= 6);
  assert.ok(loopMinutes(0, false) >= 12);
});

// ---------- Fraîcheur ----------
const NOW = 1_000_000_000; // seconde de référence fixe pour des tests déterministes

test("ageDays : âge en jours, null si date inconnue", () => {
  assert.equal(ageDays(0), null);
  assert.equal(ageDays(null), null);
  assert.equal(ageDays(NOW - 86400, NOW), 1);
  assert.equal(ageDays(NOW - 3 * 86400, NOW), 3);
});

test("pairAge : prend le relevé le plus ancien des deux", () => {
  assert.equal(pairAge(NOW - 86400, NOW - 5 * 86400, NOW), 5); // le plus vieux
  assert.equal(pairAge(NOW - 2 * 86400, 0, NOW), 2);           // un seul connu
  assert.equal(pairAge(0, 0, NOW), null);                      // aucun connu
});

test("freshnessFactor : décroît avec l'âge, plancher 0.2, 0.5 si inconnu", () => {
  assert.equal(freshnessFactor(0), 1);
  assert.equal(freshnessFactor(null), 0.5);
  assert.equal(freshnessFactor(7), 0.5);         // 1 - 7/14
  assert.equal(freshnessFactor(100), 0.2);       // plancher
  assert.ok(freshnessFactor(1) > freshnessFactor(5));
});

const close = (a, b) => Math.abs(a - b) < 1e-9;
test("availabilityFactor : sature avec le volume, 0.65 si inconnu", () => {
  assert.equal(availabilityFactor(0, 0), 0.65);
  assert.ok(close(availabilityFactor(120, 120), 0.65));  // 0.3 + 0.7*0.5
  assert.ok(availabilityFactor(1000, 1000) > availabilityFactor(100, 100));
  // prend le min(stock, demande)
  assert.ok(availabilityFactor(500, 10) < availabilityFactor(500, 500));
});

// ---------- Profit horaire & score brut ----------
test("profitPerHour : null si profit non borné, sinon profit ramené à l'heure", () => {
  assert.equal(profitPerHour(null, 30), null);
  assert.equal(profitPerHour(0, 30), 0);
  assert.equal(profitPerHour(60, 60), 60);   // 60 aUEC en 60 min -> 60/h
  assert.equal(profitPerHour(100, 30), 200); // 100 en 30 min -> 200/h
});

test("rawScoreOf : borné -> profit/h × fiabilité", () => {
  // profitHour=200, fraîcheur(0)=1, dispo(1000,1000)>0.65
  const s = rawScoreOf(200, 999, 0, 1000, 1000);
  assert.ok(close(s, 200 * 1 * availabilityFactor(1000, 1000)));
});

test("rawScoreOf : non borné (profitHour null) -> retombe sur la marge", () => {
  // base = fallbackMargin (50) car profitHour == null
  const s = rawScoreOf(null, 50, 0, 1000, 1000);
  assert.ok(close(s, 50 * 1 * availabilityFactor(1000, 1000)));
});

test("rawScoreOf : la fraîcheur pénalise un relevé plus vieux", () => {
  const fresh = rawScoreOf(200, 50, 0, 1000, 1000);
  const old = rawScoreOf(200, 50, 10, 1000, 1000);
  assert.ok(old < fresh);
});

// ---------- Score ----------
test("normalizeScores : 0-100, 100 pour le meilleur", () => {
  const rows = [{ rawScore: 50 }, { rawScore: 100 }, { rawScore: 0 }];
  normalizeScores(rows);
  assert.deepEqual(rows.map((r) => r.score), [50, 100, 0]);
});

test("normalizeScores : tout à 0 si aucun score positif", () => {
  const rows = [{ rawScore: 0 }, {}];
  normalizeScores(rows);
  assert.deepEqual(rows.map((r) => r.score), [0, 0]);
});

// ---------- Tri ----------
test("bySort : décroissant/croissant sur nombres", () => {
  const data = [{ v: 3 }, { v: 1 }, { v: 2 }];
  assert.deepEqual([...data].sort(bySort("v", -1)).map((x) => x.v), [3, 2, 1]);
  assert.deepEqual([...data].sort(bySort("v", 1)).map((x) => x.v), [1, 2, 3]);
});

test("bySort : valeurs nulles toujours en bas, quel que soit le sens", () => {
  const data = [{ v: 2 }, { v: null }, { v: 1 }];
  assert.deepEqual([...data].sort(bySort("v", -1)).map((x) => x.v), [2, 1, null]);
  assert.deepEqual([...data].sort(bySort("v", 1)).map((x) => x.v), [1, 2, null]);
});

test("bySort : chaînes triées par locale (accents)", () => {
  const data = [{ n: "Zinc" }, { n: "Étain" }, { n: "Aluminium" }];
  assert.deepEqual([...data].sort(bySort("n", 1)).map((x) => x.n), ["Aluminium", "Étain", "Zinc"]);
});

// ---------- routePasses / loopPasses (filtrage partagé) ----------
const RECENT = Math.floor(Date.now() / 1000); // relevé « maintenant » pour les tests de fraîcheur
// Route de test : intra-système, légale, hors avant-poste, relevé récent. `over` fusionne en profondeur.
const RT = (over = {}) => {
  const base = {
    same_system: true, illegal: false, commodity: "Gold",
    buy: { outpost: false, system: "Stanton", updated: RECENT },
    sell: { outpost: false, system: "Stanton", updated: RECENT },
  };
  return { ...base, ...over, buy: { ...base.buy, ...(over.buy || {}) }, sell: { ...base.sell, ...(over.sell || {}) } };
};
const NOFILTER = { sameOnly: false, noOutpost: false, legalOnly: false, sysFilter: "", maxAge: 0, q: "" };

test("routePasses : passe tout quand aucun filtre n'est actif", () => {
  assert.equal(routePasses(RT(), NOFILTER), true);
});

test("routePasses : sameOnly exclut les routes inter-systèmes", () => {
  assert.equal(routePasses(RT({ same_system: false }), { ...NOFILTER, sameOnly: true }), false);
  assert.equal(routePasses(RT({ same_system: true }), { ...NOFILTER, sameOnly: true }), true);
});

test("routePasses : noOutpost exclut si l'un des deux terminaux est un avant-poste", () => {
  assert.equal(routePasses(RT({ buy: { outpost: true } }), { ...NOFILTER, noOutpost: true }), false);
  assert.equal(routePasses(RT({ sell: { outpost: true } }), { ...NOFILTER, noOutpost: true }), false);
  assert.equal(routePasses(RT(), { ...NOFILTER, noOutpost: true }), true);
});

test("routePasses : legalOnly exclut les commodités illégales", () => {
  assert.equal(routePasses(RT({ illegal: true }), { ...NOFILTER, legalOnly: true }), false);
});

test("routePasses : sysFilter compare le système d'ACHAT uniquement", () => {
  assert.equal(routePasses(RT({ buy: { system: "Pyro" } }), { ...NOFILTER, sysFilter: "Stanton" }), false);
  assert.equal(routePasses(RT({ buy: { system: "Stanton" }, sell: { system: "Pyro" } }), { ...NOFILTER, sysFilter: "Stanton" }), true);
});

test("routePasses : q filtre par sous-chaîne insensible à la casse", () => {
  assert.equal(routePasses(RT({ commodity: "Gold" }), { ...NOFILTER, q: "gol" }), true);
  assert.equal(routePasses(RT({ commodity: "Gold" }), { ...NOFILTER, q: "iron" }), false);
});

test("routePasses : maxAge exclut les relevés trop vieux ou de date inconnue", () => {
  assert.equal(routePasses(RT(), { ...NOFILTER, maxAge: 3 }), true);                        // récent
  assert.equal(routePasses(RT({ buy: { updated: 0 }, sell: { updated: 0 } }), { ...NOFILTER, maxAge: 3 }), false); // date inconnue
  assert.equal(routePasses(RT({ buy: { updated: RECENT - 10 * 86400 } }), { ...NOFILTER, maxAge: 3 }), false);     // 10 j > 3 j
});

// Boucle de test : A et B intra-système, légales, hors avant-poste, relevés récents.
const LP = (over = {}) => {
  const base = {
    a: { system: "Stanton", outpost: false },
    b: { system: "Stanton", outpost: false },
    out: { illegal: false, commodity: "Gold", updated: RECENT },
    back: { illegal: false, commodity: "Iron", updated: RECENT },
  };
  return {
    a: { ...base.a, ...(over.a || {}) }, b: { ...base.b, ...(over.b || {}) },
    out: { ...base.out, ...(over.out || {}) }, back: { ...base.back, ...(over.back || {}) },
  };
};

test("loopPasses : sysFilter garde la boucle si A OU B correspond", () => {
  assert.equal(loopPasses(LP({ a: { system: "Pyro" }, b: { system: "Stanton" } }), { ...NOFILTER, sysFilter: "Stanton" }), true);
  assert.equal(loopPasses(LP({ a: { system: "Pyro" }, b: { system: "Pyro" } }), { ...NOFILTER, sysFilter: "Stanton" }), false);
});

test("loopPasses : legalOnly exclut si l'un des deux segments est illégal", () => {
  assert.equal(loopPasses(LP({ out: { illegal: true } }), { ...NOFILTER, legalOnly: true }), false);
  assert.equal(loopPasses(LP({ back: { illegal: true } }), { ...NOFILTER, legalOnly: true }), false);
});

test("loopPasses : q correspond à l'une OU l'autre des deux commodités", () => {
  assert.equal(loopPasses(LP({ out: { commodity: "Gold" }, back: { commodity: "Iron" } }), { ...NOFILTER, q: "iron" }), true);
  assert.equal(loopPasses(LP({ out: { commodity: "Gold" }, back: { commodity: "Iron" } }), { ...NOFILTER, q: "zinc" }), false);
});

// ---------- computeUnits ----------
const F = (o = {}) => ({ cargo: 0, budget: 0, capStock: false, useCargo: false, useBudget: false, ...o });

test("computeUnits : Infinity si aucune contrainte de volume", () => {
  assert.equal(computeUnits(100, 50, 50, F()), Infinity);
});

test("computeUnits : borné par la soute", () => {
  assert.equal(computeUnits(100, 0, 0, F({ useCargo: true, cargo: 96 })), 96);
});

test("computeUnits : borné par le budget (arrondi bas)", () => {
  assert.equal(computeUnits(100, 0, 0, F({ useBudget: true, budget: 950 })), 9);
});

test("computeUnits : plafonné par stock ET demande quand capStock actif", () => {
  const f = F({ useCargo: true, cargo: 1000, capStock: true });
  assert.equal(computeUnits(100, 300, 120, f), 120); // min(1000, 300, 120)
});

test("computeUnits : stock d'achat à 0 = terminal vide -> 0 unité (bug Levski)", () => {
  const f = F({ useCargo: true, cargo: 1000, capStock: true });
  assert.equal(computeUnits(100, 0, 120, f), 0);   // stock 0 = vide -> rien à acheter
  assert.equal(computeUnits(100, 300, 0, f), 300); // demande 0 BRUTE = quantité inconnue -> non plafonnée
});

test("computeUnits : demande corrigée par l'utilisateur est fiable (0 -> 0)", () => {
  const f = F({ useCargo: true, cargo: 1000, capStock: true });
  assert.equal(computeUnits(100, 300, 0, f, true), 0);   // demande 0 CORRIGÉE = pas de demande -> plafonne
  assert.equal(computeUnits(100, 300, 50, f, true), 50); // demande corrigée à 50 -> plafonne à 50
});

test("computeUnits : prend la plus petite contrainte (soute vs budget)", () => {
  const f = F({ useCargo: true, cargo: 96, useBudget: true, budget: 500 });
  assert.equal(computeUnits(100, 0, 0, f), 5); // min(96, floor(500/100))
});

// ---------- effValue (corrections locales + fraîcheur) ----------
test("effValue : pas de correction -> valeurs brutes", () => {
  assert.deepEqual(effValue(undefined, 100, 50, 123), { price: 100, vol: 50, oprice: false, ovol: false, stale: false });
});

test("effValue : correction appliquée si plus récente que le relevé", () => {
  const o = { price: 200, base: 1000 };
  const r = effValue(o, 100, 50, 900); // relevé (900) plus ancien que base (1000)
  assert.equal(r.price, 200);
  assert.equal(r.oprice, true);
  assert.equal(r.vol, 50);       // vol non corrigé -> brut
  assert.equal(r.stale, false);
});

test("effValue : correction périmée si le relevé UEX est plus récent (stale)", () => {
  const o = { price: 200, base: 1000 };
  const r = effValue(o, 100, 50, 1500); // relevé (1500) plus récent que base (1000)
  assert.equal(r.stale, true);
  assert.equal(r.price, 100);   // retour à la valeur UEX
  assert.equal(r.oprice, false);
});

test("effValue : base == relevé n'est PAS périmé (correction fraîche contre l'export)", () => {
  const r = effValue({ vol: 5, base: 1000 }, 100, 50, 1000);
  assert.equal(r.stale, false);
  assert.equal(r.vol, 5);
  assert.equal(r.ovol, true);
});

test("effValue : compat ascendante — legacy ts, et sans date jamais périmé", () => {
  assert.equal(effValue({ price: 9, ts: 1000 }, 1, 1, 1500).stale, true);   // ts sert de base
  assert.equal(effValue({ price: 9 }, 1, 1, 9e9).stale, false);             // ni base ni ts -> jamais périmé
  assert.equal(effValue({ price: 9, base: 1000 }, 1, 1, 0).stale, false);   // relevé inconnu (0) -> jamais périmé
});

// ---------- fillCargo (remplissage glouton du manifeste) ----------
test("fillCargo : remplit par marge décroissante, plafonné par la soute", () => {
  const items = [
    { name: "A", buyPrice: 100, stock: 999, demand: 0, margin: 50 },
    { name: "B", buyPrice: 100, stock: 999, demand: 0, margin: 30 },
  ];
  const { lines, profit } = fillCargo(items, 60, Infinity);
  assert.equal(lines.length, 1);         // A remplit toute la soute
  assert.equal(lines[0].name, "A");
  assert.equal(lines[0].units, 60);
  assert.equal(profit, 60 * 50);
});

test("fillCargo : une demande corrigée à 0 (demandKnown) exclut la ligne", () => {
  const items = [
    { name: "PasDeDem", buyPrice: 100, stock: 999, demand: 0, demandKnown: true, margin: 99 }, // demande corrigée à 0
    { name: "Ok", buyPrice: 100, stock: 999, demand: 999, margin: 10 },
  ];
  const { lines } = fillCargo(items, 50, Infinity);
  assert.deepEqual(lines.map((l) => l.name), ["Ok"]); // « PasDeDem » exclue malgré sa marge
});

test("fillCargo : une commodité au stock 0 (vide) est exclue", () => {
  const items = [
    { name: "Vide", buyPrice: 100, stock: 0, demand: 999, margin: 99 },  // meilleure marge mais vide
    { name: "Ok", buyPrice: 100, stock: 999, demand: 999, margin: 10 },
  ];
  const { lines } = fillCargo(items, 50, Infinity);
  assert.deepEqual(lines.map((l) => l.name), ["Ok"]); // « Vide » sautée malgré sa marge
});

test("fillCargo : diversifie quand le stock limite la 1re commodité", () => {
  const items = [
    { name: "A", buyPrice: 100, stock: 40, demand: 999, margin: 50 },
    { name: "B", buyPrice: 100, stock: 999, demand: 999, margin: 30 },
  ];
  const { lines } = fillCargo(items, 100, Infinity);
  assert.deepEqual(lines.map((l) => [l.name, l.units]), [["A", 40], ["B", 60]]);
});

test("fillCargo : s'arrête quand le budget est épuisé", () => {
  const items = [{ name: "A", buyPrice: 100, stock: 999, demand: 999, margin: 50 }];
  const { lines } = fillCargo(items, 1000, 500); // budget -> 5 unités
  assert.equal(lines[0].units, 5);
});

test("fillCargo : chaque ligne mémorise son plafond (cap = units)", () => {
  const items = [{ name: "A", buyPrice: 10, stock: 7, demand: 999, margin: 5 }];
  const { lines } = fillCargo(items, 100, Infinity);
  assert.equal(lines[0].cap, 7);
  assert.equal(lines[0].units, 7);
});

// ---------- scuBoxes (décomposition en caisses) ----------
test("scuBoxes : décompose par tailles standard, plus grand d'abord", () => {
  assert.deepEqual(scuBoxes(32), [{ size: 32, count: 1 }]);
  assert.deepEqual(scuBoxes(24), [{ size: 24, count: 1 }]);
  assert.deepEqual(scuBoxes(3), [{ size: 2, count: 1 }, { size: 1, count: 1 }]);
  // 279 = 8×32 + 1×16 + 1×4 + 1×2 + 1×1  (256+16+4+2+1)
  assert.deepEqual(scuBoxes(279), [
    { size: 32, count: 8 }, { size: 16, count: 1 }, { size: 4, count: 1 }, { size: 2, count: 1 }, { size: 1, count: 1 },
  ]);
});

test("scuBoxes : la somme des caisses redonne toujours N", () => {
  for (const n of [0, 1, 7, 40, 96, 123, 1000, 4608]) {
    const total = scuBoxes(n).reduce((a, b) => a + b.size * b.count, 0);
    assert.equal(total, n);
  }
});

test("scuBoxes : 0 ou négatif -> aucune caisse", () => {
  assert.deepEqual(scuBoxes(0), []);
  assert.deepEqual(scuBoxes(-5), []);
  assert.deepEqual(scuBoxes(null), []);
});

// ---------- addableUnits (suggestions) ----------
test("addableUnits : min(espace, stock, demande, budget/prix)", () => {
  const it = { buyPrice: 100, stock: 30, demand: 999 };
  assert.equal(addableUnits(it, { cargoLeft: 50, budgetLeft: Infinity }), 30);       // stock limite
  assert.equal(addableUnits(it, { cargoLeft: 10, budgetLeft: Infinity }), 10);       // soute limite
  assert.equal(addableUnits(it, { cargoLeft: 50, budgetLeft: 1500 }), 15);           // budget limite
  assert.equal(addableUnits(it, { cargoLeft: 0, budgetLeft: Infinity }), 0);         // plein
});

// ---------- bestChain (chaîne multi-sauts) ----------
// Graphe : A->B (marge 10), A->C (marge 5), B->C (marge 20), C->D (marge 30), B->A (marge 3).
const leg = (to, margin, o = {}) => ({ to, margin, stock: 999, demand: 999, buyPrice: 100, ...o });
const ADJ = new Map([
  ["A", [leg("B", 10), leg("C", 5)]],
  ["B", [leg("C", 20), leg("A", 3)]],
  ["C", [leg("D", 30)]],
  ["D", []],
]);

test("bestChain : choisit la chaîne 2 sauts la plus rentable", () => {
  // A->B->C = (10+20)*50 = 1500 ; A->C->D = (5+30)*50 = 1750 -> gagne
  const r = bestChain(ADJ, "A", 2, { cargo: 50 });
  assert.deepEqual(r.path, ["A", "C", "D"]);
  assert.equal(r.profit, 1750);
  assert.equal(r.legs.length, 2);
  assert.equal(r.legs[0].units, 50);
});

test("bestChain : ne revisite jamais un terminal (pas de A->B->A)", () => {
  const r = bestChain(ADJ, "A", 3, { cargo: 10 });
  const unique = new Set(r.path);
  assert.equal(unique.size, r.path.length); // tous distincts
});

test("bestChain : s'arrête si aucune extension (renvoie la meilleure chaîne atteinte)", () => {
  // Depuis C, un seul saut possible (C->D) ; demander 3 sauts -> chaîne d'1 saut.
  const r = bestChain(ADJ, "C", 3, { cargo: 10 });
  assert.deepEqual(r.path, ["C", "D"]);
  assert.equal(r.legs.length, 1);
});

test("bestChain : les unités par saut sont plafonnées par stock/demande", () => {
  const adj = new Map([
    ["A", [leg("B", 10, { stock: 20, demand: 999 })]],
    ["B", [leg("C", 10, { stock: 999, demand: 5 })]],
    ["C", []],
  ]);
  const r = bestChain(adj, "A", 2, { cargo: 100 });
  assert.equal(r.legs[0].units, 20); // stock A->B
  assert.equal(r.legs[1].units, 5);  // demande B->C
  assert.equal(r.profit, 20 * 10 + 5 * 10);
});

test("bestChain : null si aucun saut rentable", () => {
  assert.equal(bestChain(new Map([["A", []]]), "A", 3, { cargo: 50 }), null);
});

test("bestChain : un saut dont le stock est 0 (vide) est écarté", () => {
  const adj = new Map([
    ["A", [leg("B", 99, { stock: 0 }), leg("C", 10)]], // A->B très rentable mais vide
    ["B", []],
    ["C", []],
  ]);
  const r = bestChain(adj, "A", 1, { cargo: 50 });
  assert.deepEqual(r.path, ["A", "C"]); // on prend C, pas le B vide
});

// ---------- ovKey / effFromStore / setInStore (moteur de corrections, store injectable) ----------
test("ovKey : clé stable commodité|terminal|side", () => {
  assert.equal(ovKey("Laranite", "CRU-L1", "buy"), "Laranite|CRU-L1|buy");
});

test("setInStore : enregistre prix + base, efface un champ, supprime la clé si vide", () => {
  const store = {};
  setInStore(store, "A|T|buy", "price", "7000", 111);
  assert.deepEqual(store["A|T|buy"], { price: 7000, base: 111 }); // valeur arrondie + base
  setInStore(store, "A|T|buy", "vol", 50, 222);
  assert.deepEqual(store["A|T|buy"], { price: 7000, vol: 50, base: 222 });
  setInStore(store, "A|T|buy", "price", "", 222); // efface le prix
  assert.deepEqual(store["A|T|buy"], { vol: 50, base: 222 });
  setInStore(store, "A|T|buy", "vol", null, 222);  // plus rien -> clé supprimée
  assert.equal("A|T|buy" in store, false);
});

test("setInStore : borne à >= 0 et arrondit", () => {
  const store = {};
  setInStore(store, "k", "price", -5, 0);
  assert.equal(store.k.price, 0);
  setInStore(store, "k", "vol", 3.7, 0);
  assert.equal(store.k.vol, 4);
});

test("effFromStore : valeur brute si pas de correction", () => {
  const store = {};
  assert.deepEqual(effFromStore(store, "k", 100, 50, 123), { price: 100, vol: 50, oprice: false, ovol: false, stale: false });
});

test("effFromStore : applique la correction plus récente que le relevé", () => {
  const store = { k: { price: 200, base: 1000 } };
  const r = effFromStore(store, "k", 100, 50, 900); // relevé plus ancien que base
  assert.equal(r.price, 200);
  assert.equal(r.oprice, true);
  assert.equal("k" in store, true); // conservée
});

test("effFromStore : SUPPRIME du store la correction périmée par un relevé plus récent", () => {
  const store = { k: { price: 200, base: 1000 } };
  const r = effFromStore(store, "k", 100, 50, 1500); // relevé plus récent que base
  assert.equal(r.stale, true);
  assert.equal(r.price, 100);          // retour à la valeur UEX
  assert.equal("k" in store, false);   // effet de bord : périmée -> supprimée
});

// ---------- safeKey / encodeState / decodeState (persistance) ----------
test("safeKey : n'accepte que des lettres (anti-injection de sélecteur)", () => {
  assert.equal(safeKey("score"), true);
  assert.equal(safeKey("loopMargin"), true);
  assert.equal(safeKey('score"]'), false);
  assert.equal(safeKey("a-b"), false);
  assert.equal(safeKey(""), false);
  assert.equal(safeKey(null), false);
});

test("encodeState : ignore les valeurs vides et nulles", () => {
  const s = encodeState({ v: "routes", cargo: 96, search: "", system: undefined, x: null });
  assert.equal(s, "v=routes&cargo=96");
});

test("encodeState/decodeState : round-trip fidèle", () => {
  const state = { v: "chain", cargo: "600", origin: "Seraphim — Stanton", useCargo: 1, capStock: 0 };
  const decoded = decodeState(encodeState(state));
  // tout revient sous forme de chaînes (query-string)
  assert.equal(decoded.v, "chain");
  assert.equal(decoded.cargo, "600");
  assert.equal(decoded.origin, "Seraphim — Stanton");
  assert.equal(decoded.useCargo, "1");
  assert.equal(decoded.capStock, "0");
});

test("decodeState : chaîne vide -> null", () => {
  assert.equal(decodeState(""), null);
  assert.equal(decodeState(undefined), null);
});

// ---------- routeMetrics / loopMetrics (cœurs de calcul dérivés) ----------
test("routeMetrics : borné par la soute -> units/profit/investment/temps", () => {
  const m = { buyPrice: 100, buyStock: 500, sellDemand: 300, margin: 50, distance: 0, sameSystem: true, buyUpdated: NOW, sellUpdated: NOW };
  const r = routeMetrics(m, F({ useCargo: true, cargo: 96 }));
  assert.equal(r.units, 96);
  assert.equal(r.investment, 96 * 100);
  assert.equal(r.profit, 96 * 50);
  assert.equal(r.minutes, 6);              // tripMinutes(0, false)
  assert.equal(r.profitHour, (96 * 50 * 60) / 6);
  assert.ok(r.rawScore > 0);
});

test("routeMetrics : non borné (aucune contrainte) -> units/profit/investment null", () => {
  const m = { buyPrice: 100, buyStock: 500, sellDemand: 300, margin: 50, distance: 0, sameSystem: true, buyUpdated: NOW, sellUpdated: NOW };
  const r = routeMetrics(m, F());
  assert.equal(r.units, null);
  assert.equal(r.profit, null);
  assert.equal(r.investment, null);
  assert.equal(r.profitHour, null);
  assert.ok(r.rawScore > 0); // score sur la marge quand non borné
});

test("routeMetrics : saut inter-système ajoute du temps de trajet", () => {
  const base = { buyPrice: 100, buyStock: 500, sellDemand: 300, margin: 50, distance: 100, buyUpdated: NOW, sellUpdated: NOW };
  const same = routeMetrics({ ...base, sameSystem: true }, F({ useCargo: true, cargo: 10 }));
  const cross = routeMetrics({ ...base, sameSystem: false }, F({ useCargo: true, cargo: 10 }));
  assert.ok(cross.minutes > same.minutes);
});

test("loopMetrics : bornée -> units aller+retour, investment = max des deux jambes", () => {
  const out = { buyPrice: 100, stock: 500, demand: 300, margin: 50, updated: NOW };
  const back = { buyPrice: 80, stock: 400, demand: 200, margin: 30, updated: NOW };
  const r = loopMetrics(out, back, 0, false, F({ useCargo: true, cargo: 100 }));
  assert.equal(r.loopMargin, 80);
  assert.equal(r.unitsOut, 100);
  assert.equal(r.unitsBack, 100);
  assert.equal(r.units, 200);
  assert.equal(r.profit, 100 * 50 + 100 * 30);
  assert.equal(r.investment, Math.max(100 * 100, 100 * 80)); // 10000
  assert.equal(r.minutes, 12); // loopMinutes(0, false)
});

test("loopMetrics : non bornée si une seule jambe l'est -> units null", () => {
  const out = { buyPrice: 100, stock: 500, demand: 300, margin: 50, updated: NOW };
  const back = { buyPrice: 80, stock: 400, demand: 200, margin: 30, updated: NOW };
  const r = loopMetrics(out, back, 0, false, F()); // aucune contrainte -> Infinity
  assert.equal(r.units, null);
  assert.equal(r.profit, null);
  assert.equal(r.investment, null);
});

// ---------- Marché : dealFrom / enRouteDeals / bestManifest / buildChainAdjacency ----------
// Marché de test : A,B (Stanton), C (Pyro, avant-poste). Tuples buy/sell = [idx, prix, vol, updated, statut].
const MKT = () => ({
  terminals: [
    { name: "A", system: "Stanton", planet: "Hurston", outpost: false },  // 0
    { name: "B", system: "Stanton", planet: "Crusader", outpost: false },  // 1
    { name: "C", system: "Pyro", planet: "Ruin", outpost: true },          // 2
  ],
  commodities: [
    { name: "Gold", kind: "metal", illegal: false,
      buys: [[0, 100, 500, NOW, 5]],
      sells: [[1, 150, 300, NOW, 3], [2, 300, 500, NOW, 2]] },
    { name: "Drug", kind: "drug", illegal: true,
      buys: [[0, 50, 100, NOW, 5]],
      sells: [[1, 80, 100, NOW, 3]] },
  ],
});
// Résolveur identité (aucune correction locale).
const idResolve = (_c, _t, _s, price, vol) => ({ price, vol, ovol: false });

test("dealFrom : construit une route depuis un achat + une vente", () => {
  const mkt = MKT();
  const c = mkt.commodities[0];
  const d = dealFrom(mkt, c, c.buys[0], c.sells[0]);
  assert.equal(d.commodity, "Gold");
  assert.equal(d.buy.terminal, "A");
  assert.equal(d.sell.terminal, "B");
  assert.equal(d.margin, 50);
  assert.equal(d.roi, 50);           // (50/100)*100
  assert.equal(d.same_system, true);
});

test("enRouteDeals : meilleure vente par commodité depuis l'origine", () => {
  const deals = enRouteDeals(MKT(), 0, "");
  assert.equal(deals.length, 2);
  const gold = deals.find((d) => d.commodity === "Gold");
  assert.equal(gold.sell.terminal, "C"); // 300 > 150 -> meilleure vente
  assert.equal(gold.margin, 200);
});

test("enRouteDeals : filtre par système d'arrivée", () => {
  const deals = enRouteDeals(MKT(), 0, "Stanton");
  const gold = deals.find((d) => d.commodity === "Gold");
  assert.equal(gold.sell.terminal, "B"); // C (Pyro) exclu -> repli sur B
  assert.equal(gold.margin, 50);
});

test("enRouteDeals : aucune vente depuis un terminal sans achat", () => {
  assert.equal(enRouteDeals(MKT(), 1, "").length, 0); // rien ne s'achète en B
});

test("bestManifest : choisit la destination la plus rentable", () => {
  const f = F({ useCargo: true, cargo: 100 });
  const m = bestManifest(MKT(), 0, "", f, idResolve);
  assert.equal(m.dest.name, "C");         // Gold marge 200 vers C
  assert.equal(m.profit, 100 * 200);
  assert.equal(m.lines.length, 1);
});

test("bestManifest : noOutpost écarte C -> repli sur B", () => {
  const f = F({ useCargo: true, cargo: 100, noOutpost: true });
  const m = bestManifest(MKT(), 0, "", f, idResolve);
  assert.equal(m.dest.name, "B");
  assert.equal(m.profit, 100 * 50);
});

test("bestManifest : le budget plafonne les unités chargées", () => {
  const f = F({ useCargo: true, cargo: 100, useBudget: true, budget: 5000 });
  const m = bestManifest(MKT(), 0, "", f, idResolve);
  assert.equal(m.dest.name, "C");
  assert.equal(m.lines[0].units, 50);     // floor(5000/100)
  assert.equal(m.profit, 50 * 200);
});

test("bestManifest : null si la soute n'est pas contrainte", () => {
  assert.equal(bestManifest(MKT(), 0, "", F(), idResolve), null);
});

test("buildChainAdjacency : meilleure marge par paire de terminaux", () => {
  const adj = buildChainAdjacency(MKT(), { legalOnly: false, noOutpost: false }, idResolve);
  const legs = adj.get(0);
  assert.equal(legs.length, 2);           // 0->1 et 0->2
  const to2 = legs.find((l) => l.to === 2);
  assert.equal(to2.commodity, "Gold");
  assert.equal(to2.margin, 200);
  const to1 = legs.find((l) => l.to === 1);
  assert.equal(to1.commodity, "Gold");    // Gold (marge 50) bat Drug (marge 30) sur 0->1
  assert.equal(to1.margin, 50);
});

test("buildChainAdjacency : noOutpost écarte les segments vers/depuis un avant-poste", () => {
  const adj = buildChainAdjacency(MKT(), { legalOnly: false, noOutpost: true }, idResolve);
  const legs = adj.get(0);
  assert.equal(legs.length, 1);           // 0->2 (C avant-poste) retiré
  assert.equal(legs[0].to, 1);
});

test("buildChainAdjacency : legalOnly écarte les commodités illégales", () => {
  // Marché où seule une commodité illégale relie 0->1.
  const mkt = {
    terminals: [{ name: "A", system: "S", planet: "", outpost: false }, { name: "B", system: "S", planet: "", outpost: false }],
    commodities: [{ name: "Drug", kind: "drug", illegal: true, buys: [[0, 50, 100, NOW, 5]], sells: [[1, 120, 100, NOW, 3]] }],
  };
  assert.equal(buildChainAdjacency(mkt, { legalOnly: true, noOutpost: false }, idResolve).size, 0);
  assert.equal(buildChainAdjacency(mkt, { legalOnly: false, noOutpost: false }, idResolve).get(0).length, 1);
});

// ---------- Commodités : résumé global + points d'achat/vente ----------
const CMKT = {
  terminals: [
    { name: "A", system: "Stanton", planet: "Hurston", outpost: false },
    { name: "B", system: "Stanton", planet: "Crusader", outpost: false },
    { name: "C", system: "Pyro", planet: "Ruin", outpost: true },
  ],
  commodities: [
    { name: "Gold", code: "GOLD", kind: "metal", illegal: false,
      buys: [[0, 100, 500, NOW, 5], [1, 90, 200, NOW, 4]],
      sells: [[1, 150, 300, NOW, 3], [2, 300, 50, NOW, 2]] },
    { name: "Drug", code: "DRUG", kind: "drug", illegal: true,
      buys: [[0, 50, 100, NOW, 5]], sells: [] },
  ],
};

test("commoditySummaries : meilleur achat/vente + marge par commodité", () => {
  const gold = commoditySummaries(CMKT).find((x) => x.name === "Gold");
  assert.equal(gold.code, "GOLD");
  assert.equal(gold.bestBuy, 90);    // achat le moins cher
  assert.equal(gold.bestSell, 300);  // vente la plus chère
  assert.equal(gold.margin, 210);
  assert.equal(gold.nBuy, 2);
  assert.equal(gold.nSell, 2);
  assert.equal(gold.buyStatus, 4);   // statut au point d'achat le moins cher
  assert.equal(gold.sellStatus, 2);  // statut au point de vente le mieux payé
});

test("commoditySummaries : marge/vente null si aucun point de vente", () => {
  const drug = commoditySummaries(CMKT).find((x) => x.name === "Drug");
  assert.equal(drug.bestSell, null);
  assert.equal(drug.margin, null);
  assert.equal(drug.nSell, 0);
});

test("commodityPoints : achats du moins cher, ventes du plus cher, avec terminal", () => {
  const p = commodityPoints(CMKT, "Gold");
  assert.deepEqual(p.buys.map((b) => b.price), [90, 100]);
  assert.deepEqual(p.sells.map((s) => s.price), [300, 150]);
  assert.equal(p.buys[0].terminal, "B");
  assert.equal(p.buys[0].stock, 200);
  assert.equal(p.sells[0].terminal, "C");
  assert.equal(p.sells[0].demand, 50);
});

test("commodityPoints : null si commodité inconnue", () => {
  assert.equal(commodityPoints(CMKT, "Inconnu"), null);
});

// ---------- Cohérence des filtres par vue (garde-fou anti-régression) ----------
test("buildChainAdjacency : sameOnly écarte les segments inter-systèmes", () => {
  const adj = buildChainAdjacency(MKT(), { sameOnly: true }, idResolve);
  const legs = adj.get(0);
  assert.equal(legs.length, 1);   // A->C (Pyro) exclu, reste A->B (Stanton)
  assert.equal(legs[0].to, 1);
});

test("buildChainAdjacency : maxAge écarte les segments trop vieux", () => {
  const old = RECENT - 10 * 86400;
  const mkt = {
    terminals: [
      { name: "A", system: "S", planet: "", outpost: false },
      { name: "B", system: "S", planet: "", outpost: false },
      { name: "C", system: "S", planet: "", outpost: false },
    ],
    commodities: [{
      name: "X", code: "X", kind: "metal", illegal: false,
      buys: [[0, 100, 500, RECENT, 5]],
      sells: [[1, 150, 300, RECENT, 3], [2, 200, 300, old, 2]], // B frais, C périmé
    }],
  };
  const legs = buildChainAdjacency(mkt, { maxAge: 3 }, idResolve).get(0);
  assert.equal(legs.length, 1);   // A->C (vieux) écarté
  assert.equal(legs[0].to, 1);
});

test("commoditySummaries : legalOnly masque les commodités illégales", () => {
  const s = commoditySummaries(CMKT, { legalOnly: true });
  assert.equal(s.length, 1);
  assert.equal(s[0].name, "Gold");
});

test("commoditySummaries : noOutpost exclut les points en avant-poste du calcul", () => {
  const gold = commoditySummaries(CMKT, { noOutpost: true }).find((x) => x.name === "Gold");
  assert.equal(gold.bestSell, 150); // vente à 300 (avant-poste C) exclue -> B à 150
  assert.equal(gold.nSell, 1);
  assert.equal(gold.bestBuy, 90);   // achats non touchés (aucun avant-poste)
});

test("commodityPoints : noOutpost exclut les points en avant-poste", () => {
  const p = commodityPoints(CMKT, "Gold", { noOutpost: true });
  assert.equal(p.sells.length, 1);
  assert.equal(p.sells[0].terminal, "B");
  assert.equal(p.buys.length, 2);
});

test("compactValue : notation compacte K/M", () => {
  assert.equal(compactValue(9600), "9.6K");
  assert.equal(compactValue(146300), "146.3K");
  assert.equal(compactValue(500000), "500K");
  assert.equal(compactValue(1600000), "1.6M");
  assert.equal(compactValue(540), "540");
  assert.equal(compactValue(0), "0");
  assert.equal(compactValue(null), "—");
});

test("enRouteDeals : destTerminal force le terminal d'arrivée", () => {
  const toC = enRouteDeals(MKT(), 0, "", 2); // force C (idx 2)
  const gold = toC.find((d) => d.commodity === "Gold");
  assert.equal(gold.sell.terminal, "C");
  assert.equal(gold.margin, 200);
  assert.equal(toC.some((d) => d.commodity === "Drug"), false); // Drug ne vend pas à C
});

test("bestManifest : destTerminal force la destination", () => {
  const f = F({ useCargo: true, cargo: 100 });
  assert.equal(bestManifest(MKT(), 0, "", f, idResolve, 1).dest.name, "B"); // forcé sur B
  const toC = bestManifest(MKT(), 0, "", f, idResolve, 2);                   // forcé sur C
  assert.equal(toC.dest.name, "C");
  assert.equal(toC.profit, 100 * 200);
});

// ---------- Compagnon de voyage : modèle de parcours ----------
const ROUTE_AB = { commodity: "Gold", margin: 50, buy: { terminal: "A", system: "Stanton", price: 100 }, sell: { terminal: "B", system: "Stanton", price: 150 } };
const LOOP_BC = {
  a: { terminal: "B", system: "Stanton" }, b: { terminal: "C", system: "Pyro" },
  out: { commodity: "Iron", buyPrice: 10, sellPrice: 40, margin: 30 },
  back: { commodity: "Wood", buyPrice: 5, sellPrice: 20, margin: 15 },
};

test("legFromRoute : trajet évalué -> une jambe", () => {
  const leg = legFromRoute(ROUTE_AB);
  assert.deepEqual(leg, { from: "A", fromSystem: "Stanton", to: "B", toSystem: "Stanton", commodity: "Gold", buyPrice: 100, sellPrice: 150, margin: 50 });
});

test("legsFromLoop : boucle -> aller + retour", () => {
  const legs = legsFromLoop(LOOP_BC);
  assert.equal(legs.length, 2);
  assert.deepEqual([legs[0].from, legs[0].to], ["B", "C"]);
  assert.deepEqual([legs[1].from, legs[1].to], ["C", "B"]);
  assert.equal(legs[0].commodity, "Iron");
});

test("legsFromLoop : startAt == b -> on entre par b (cycle inversé)", () => {
  const legs = legsFromLoop(LOOP_BC, "C"); // le parcours finit en C, pas en B
  assert.deepEqual([legs[0].from, legs[0].to], ["C", "B"]);
  assert.deepEqual([legs[1].from, legs[1].to], ["B", "C"]);
  assert.equal(legs[0].commodity, "Wood"); // le retour devient l'aller
});

test("legsFromLoop : startAt inconnu ou == a -> orientation par défaut", () => {
  for (const s of [undefined, null, "B", "ZZZ"]) {
    const legs = legsFromLoop(LOOP_BC, s);
    assert.deepEqual([legs[0].from, legs[0].to], ["B", "C"], `startAt=${s}`);
  }
});

// Régression : une boucle raccordée au parcours par son `b` doit ÉTENDRE, pas remplacer.
// Sans orientation, legsFromLoop partait toujours de `a` -> journeyConnects false -> voyage écrasé.
test("addToJourney : une boucle orientée sur la fin du parcours étend (régression)", () => {
  const j = startJourney([legFromRoute(ROUTE_AB)]); // A->B, finit en B
  const loopCB = { ...LOOP_BC, a: { terminal: "C", system: "Pyro" }, b: { terminal: "B", system: "Stanton" } };
  const legs = legsFromLoop(loopCB, journeyEnd(j).name); // se raccorde par b == "B"
  assert.equal(journeyConnects(j, legs), true);
  assert.deepEqual(journeyStations(addToJourney(j, legs)).map((s) => s.name), ["A", "B", "C", "B"]);
});

test("legsFromChain : chaîne (index) -> jambes nommées", () => {
  const terminals = [{ name: "A", system: "Stanton" }, { name: "B", system: "Stanton" }, { name: "D", system: "Pyro" }];
  const chain = { path: [0, 1, 2], legs: [{ commodity: "X", buyPrice: 1, sellPrice: 3, margin: 2 }, { commodity: "Y", buyPrice: 2, sellPrice: 8, margin: 6 }] };
  const legs = legsFromChain(chain, terminals);
  assert.deepEqual(legs.map((l) => [l.from, l.to]), [["A", "B"], ["B", "D"]]);
  assert.equal(legs[1].toSystem, "Pyro");
});

test("startJourney + journeyStations : stations = legs.length + 1", () => {
  const j = startJourney([legFromRoute(ROUTE_AB)]);
  assert.equal(j.current, 0);
  assert.deepEqual(journeyStations(j).map((s) => s.name), ["A", "B"]);
  assert.equal(journeyEnd(j).name, "B");
});

test("journeyConnects : les jambes s'enchaînent si leur départ == fin du parcours", () => {
  const j = startJourney([legFromRoute(ROUTE_AB)]); // finit en B
  assert.equal(journeyConnects(j, legsFromLoop(LOOP_BC)), true);   // boucle part de B
  assert.equal(journeyConnects(j, [legFromRoute(ROUTE_AB)]), false); // repart de A, pas B
});

test("addToJourney : ÉTEND si ça s'enchaîne, sinon REMPLACE", () => {
  const j = startJourney([legFromRoute(ROUTE_AB)]); // A->B
  const ext = addToJourney(j, legsFromLoop(LOOP_BC)); // B->C->B
  assert.deepEqual(journeyStations(ext).map((s) => s.name), ["A", "B", "C", "B"]);
  // ne s'enchaîne pas -> remplace
  const other = { commodity: "Z", margin: 1, buy: { terminal: "X", system: "S", price: 1 }, sell: { terminal: "Y", system: "S", price: 2 } };
  const repl = addToJourney(j, [legFromRoute(other)]);
  assert.deepEqual(journeyStations(repl).map((s) => s.name), ["X", "Y"]);
});

test("setJourneyPosition + currentLeg : position bornée, jambe courante = current -> current+1", () => {
  const j = addToJourney(startJourney([legFromRoute(ROUTE_AB)]), legsFromLoop(LOOP_BC)); // A->B->C->B (3 jambes)
  assert.equal(currentLeg(j).from, "A");                 // current 0 -> jambe A->B
  const j2 = setJourneyPosition(j, 2);                   // à la station index 2 (C)
  assert.equal(currentLeg(j2).from, "C");                // jambe C->B
  const j3 = setJourneyPosition(j, 99);                  // borné à legs.length (3) = dernière station
  assert.equal(currentLeg(j3), null);                    // au bout, plus de jambe
  assert.equal(setJourneyPosition(j, -5).current, 0);    // borné à 0
});

test("journeyMargin : somme des marges des jambes", () => {
  const j = addToJourney(startJourney([legFromRoute(ROUTE_AB)]), legsFromLoop(LOOP_BC)); // 50 + 30 + 15
  assert.equal(journeyMargin(j), 95);
});

test("encodeJourney / decodeJourney : aller-retour + robustesse", () => {
  const j = addToJourney(startJourney([legFromRoute(ROUTE_AB)]), legsFromLoop(LOOP_BC));
  const round = decodeJourney(encodeJourney(j));
  assert.deepEqual(journeyStations(round).map((s) => s.name), ["A", "B", "C", "B"]);
  assert.equal(round.current, j.current);
  assert.equal(round.legs[0].margin, 50);
  assert.equal(encodeJourney(null), "");          // vide
  assert.equal(encodeJourney({ legs: [] }), "");   // pas de jambe ni départ
  assert.equal(decodeJourney(""), null);           // vide
  assert.equal(decodeJourney("pas du json"), null); // malformé -> null (pas d'exception)
});

test("startJourneyAt : voyage « de zéro » = un point de départ, aucune jambe", () => {
  const j = startJourneyAt({ name: "A", system: "Stanton" });
  assert.deepEqual(j.legs, []);
  assert.equal(j.current, 0);
  assert.deepEqual(journeyStations(j).map((s) => s.name), ["A"]); // une seule station
  assert.equal(journeyEnd(j).name, "A");                          // la fin = le départ
  assert.equal(startJourneyAt(null), null);                       // robustesse
  assert.equal(startJourneyAt({ system: "S" }), null);            // sans nom -> null
});

test("addToJourney depuis un voyage « de zéro » : la 1re jambe partant du départ ÉTEND", () => {
  const j = startJourneyAt({ name: "A", system: "Stanton" }); // départ A, 0 jambe
  const ext = addToJourney(j, [legFromRoute(ROUTE_AB)]);      // A->B part de A -> enchaîne
  assert.deepEqual(journeyStations(ext).map((s) => s.name), ["A", "B"]);
  assert.equal(ext.legs.length, 1);
});

test("encodeJourney / decodeJourney : aller-retour d'un voyage « de zéro »", () => {
  const j = startJourneyAt({ name: "A", system: "Stanton" });
  const round = decodeJourney(encodeJourney(j));
  assert.deepEqual(round.legs, []);
  assert.equal(round.start.name, "A");
  assert.equal(round.start.system, "Stanton");
  assert.deepEqual(journeyStations(round).map((s) => s.name), ["A"]);
});
