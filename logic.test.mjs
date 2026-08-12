// Batterie de tests des fonctions de calcul pures (app.js s'appuie dessus).
// Lancer : `node --test` (ou `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  tripMinutes, loopMinutes, ageDays, pairAge, freshnessFactor, availabilityFactor, tighterVolume,
  normalizeScores, bySort, computeUnits, effValue, fillCargo, addableUnits, scuBoxes, cargoBoxes, bestChain,
  AUTOLOAD, autoloadFee, autoloadPoint, haulFee, lineHaulFee,
  manifestTotals, freeAddUnits, manifestLine, stationLabel, parseStationLabel,
  ovKey, effFromStore, setInStore, safeKey, encodeState, decodeState,
  profitPerHour, rawScoreOf, routePasses, loopPasses,
  routeMetrics, loopMetrics, netMarginRoi, dealFrom, enRouteDeals, bestManifest, buildChainAdjacency,
  pairEligible, suggestionsFrom,
  manifestsFrom, multiTrips, tripMetrics, legFromTrip,
  commoditySummaries, commodityPoints, compactValue, valueTiers, resolveCommodity, ambiguousCodes,
  legFromRoute, legsFromLoop, legsFromChain, legFromManifest, stopSuggestions, bestLegBetween,
  manifestJourneyState, manifestIntent, sameIntent, legsToPin,
  startJourney, startJourneyAt, journeyStations, journeyEnd,
  journeyConnects, addToJourney, setJourneyPosition, currentLeg, journeyMargin,
  encodeJourney, decodeJourney, removeJourneyStop, freeManifestLine, hydrateManifestLine,
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

test("availabilityFactor : demande inconnue (null) ≠ demande nulle (saturé)", () => {
  // UEX ne renseigne `scu_sell` que sur une minorité de points -> demande null = capacité
  // inconnue. La noter comme un terminal saturé pénalisait 4 routes sur 5 sans raison.
  assert.ok(availabilityFactor(128, null) > availabilityFactor(128, 0));
  // Demande inconnue -> on ne juge que le stock, exactement comme si la demande ne bornait pas.
  assert.ok(close(availabilityFactor(128, null), availabilityFactor(128, Infinity)));
  // Un stock plus fourni reste mieux noté, même sans demande connue…
  assert.ok(availabilityFactor(500, null) > availabilityFactor(128, null));
  // …et un terminal d'achat bien approvisionné ne doit pas scorer sous un terminal vide.
  assert.ok(availabilityFactor(128, null) > availabilityFactor(0, null));
  // 0 CONNU reste une saturation : pénalité maximale.
  assert.equal(availabilityFactor(500, 0), 0.3);
});

test("tighterVolume : ignore les capacités inconnues au lieu de les compter pour 0", () => {
  assert.equal(tighterVolume(160, 7), 7);
  assert.equal(tighterVolume(null, 7), 7);       // Math.min(null, 7) vaudrait 0
  assert.equal(tighterVolume(160, null), 160);
  assert.equal(tighterVolume(null, null), null); // rien de connu -> inconnu
  assert.equal(tighterVolume(160, 0), 0);        // 0 connu = saturé, il prime
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
  assert.equal(computeUnits(100, 0, 120, f), 0);      // stock 0 = vide -> rien à acheter
  assert.equal(computeUnits(100, 300, null, f), 300); // demande null = capacité inconnue -> non plafonnée
});

test("computeUnits : demande 0 CONNUE = terminal saturé -> 0 unité", () => {
  const f = F({ useCargo: true, cargo: 1000, capStock: true });
  // Depuis la correction de sémantique UEX, la demande est la capacité RESTANTE : un 0 issu des
  // données signifie « le terminal est plein, il ne prend plus rien » (statut_sell 7).
  assert.equal(computeUnits(100, 300, 0, f), 0);
  assert.equal(computeUnits(100, 300, 40, f), 40);  // capacité restante 40 -> plafonne à 40
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
  const items = [ // demand null = capacité UEX inconnue -> aucun plafond de volume à la vente
    { name: "A", buyPrice: 100, stock: 999, demand: null, margin: 50 },
    { name: "B", buyPrice: 100, stock: 999, demand: null, margin: 30 },
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

test("scuBoxes : maxBox plafonne la taille de caisse", () => {
  // Un terminal à max_container_size = 16 ne peut PAS sortir une caisse de 32.
  assert.deepEqual(scuBoxes(32, 16), [{ size: 16, count: 2 }]);
  assert.deepEqual(scuBoxes(24, 8), [{ size: 8, count: 3 }]);
  // Le plafond n'a pas à être une taille standard : on descend à la plus grande caisse qui tient.
  assert.deepEqual(scuBoxes(32, 24), [{ size: 24, count: 1 }, { size: 8, count: 1 }]);
  // Contre-épreuve : sans plafond, ces mêmes volumes font moins de caisses.
  assert.deepEqual(scuBoxes(32), [{ size: 32, count: 1 }]);
  assert.deepEqual(scuBoxes(24), [{ size: 24, count: 1 }]);
});

test("scuBoxes : sans maxBox (ou plafond inexploitable), comportement strictement inchangé", () => {
  // Les appelants d'affichage existants passent un seul argument : leur sortie ne doit pas bouger.
  for (const n of [0, 1, 7, 40, 96, 123, 1000, 4608]) {
    assert.deepEqual(scuBoxes(n, undefined), scuBoxes(n));
    assert.deepEqual(scuBoxes(n, null), scuBoxes(n));
    assert.deepEqual(scuBoxes(n, 32), scuBoxes(n));      // 32 = plus grande caisse : plafond sans effet
    // Un plafond aberrant ne doit pas faire disparaître du volume (aucune caisse ne tiendrait).
    assert.deepEqual(scuBoxes(n, 0), scuBoxes(n));
    assert.deepEqual(scuBoxes(n, -1), scuBoxes(n));
  }
});

test("scuBoxes : plafonnée, la somme des caisses redonne toujours N", () => {
  for (const n of [0, 1, 7, 40, 96, 123, 1000, 4608]) {
    for (const maxBox of [1, 2, 4, 8, 16, 24, 32]) {
      const total = scuBoxes(n, maxBox).reduce((a, b) => a + b.size * b.count, 0);
      assert.equal(total, n, `${n} SCU plafonnés à ${maxBox}`);
      assert.ok(scuBoxes(n, maxBox).every((b) => b.size <= maxBox), `caisse > ${maxBox}`);
    }
  }
});

test("cargoBoxes : les caisses se comptent PAR LIGNE, jamais sur le total des SCU", () => {
  // Une caisse ne contient qu'une commodité. Quatre lignes de 8 SCU font quatre caisses de 8 —
  // les décomposer ensemble en annoncerait UNE de 32, qui n'existe pas, et ce décompte sert à
  // expliquer un montant facturé, lui, ligne par ligne.
  const lignes = [8, 8, 8, 8].map((units) => ({ units }));
  assert.deepEqual(cargoBoxes(lignes, 32), [{ size: 8, count: 4 }]);
  assert.deepEqual(scuBoxes(32, 32), [{ size: 32, count: 1 }]); // contre-épreuve : le total mentirait
  // Tailles mélangées : regroupées par taille, plus grande d'abord.
  assert.deepEqual(cargoBoxes([{ units: 32 }, { units: 24 }, { units: 8 }], 32), [
    { size: 32, count: 1 }, { size: 24, count: 1 }, { size: 8, count: 1 },
  ]);
  // Le plafond du terminal s'applique à chaque ligne, et le volume ne s'évapore jamais.
  assert.deepEqual(cargoBoxes([{ units: 32 }, { units: 32 }], 16), [{ size: 16, count: 4 }]);
  assert.deepEqual(cargoBoxes([], 32), []);
  assert.deepEqual(cargoBoxes([{ units: 0 }], 32), []);
  for (const lignes2 of [[{ units: 7 }, { units: 41 }, { units: 96 }], [{ units: 123 }]]) {
    const total = cargoBoxes(lignes2, 24).reduce((a, b) => a + b.size * b.count, 0);
    assert.equal(total, lignes2.reduce((a, l) => a + l.units, 0));
  }
});

test("cargoBoxes : le décompte de caisses est celui que facture manifestTotals", () => {
  // L'invariant qui manquait : l'infobulle annonçait « 32 SCU en 1 caisse » sous un montant
  // calculé sur quatre. Le nombre de caisses affiché doit redonner le montant déduit.
  const pair = { buy: { maxBox: 32, k: 1 }, sell: { maxBox: 32, k: 1 } };
  const lignes = [8, 8, 8, 8].map((units) => ({ units, buyPrice: 10, margin: 100 }));
  const { fees, scu } = manifestTotals(lignes, pair);
  const caisses = cargoBoxes(lignes, 32).reduce((a, b) => a + b.count, 0);
  assert.equal(caisses, 4);
  // Deux opérations, une transaction par commodité (hypothèse 2) : la formule doit tomber juste.
  assert.equal(fees, 2 * (lignes.length * AUTOLOAD.base + AUTOLOAD.perBox * caisses + AUTOLOAD.perScu * scu));
  // Et le décompte du TOTAL, lui, ne redonne PAS le montant : c'est le bug qu'on interdit.
  const surLeTotal = scuBoxes(scu, 32).reduce((a, b) => a + b.count, 0);
  assert.notEqual(fees, 2 * (AUTOLOAD.base + AUTOLOAD.perBox * surLeTotal + AUTOLOAD.perScu * scu));
});

// ---------- Frais d'autoload ----------
// Les 18 relevés en jeu (Star Citizen 4.9) qui ont produit la grille AUTOLOAD, recopiés depuis
// docs/superpowers/specs/2026-08-10-frais-autoload-design.md. Les deux stations sont
// max_container_size = 32, donc « ×n caisses de b SCU » se lit (scu = b*n, maxBox = b).
// Ce test est le garde-fou du modèle : un changement de grille à un patch du jeu doit le faire
// tomber plutôt que de laisser l'app classer sur des frais devenus faux.
const RELEVES = [
  // Admin — Endgame (Pyro, Rough & Ready) : c'est l'ancrage, k = 1 par définition.
  { station: "Endgame", k: 1, boxSize: 8, count: 1, observe: 340 },
  { station: "Endgame", k: 1, boxSize: 8, count: 2, observe: 530 },
  { station: "Endgame", k: 1, boxSize: 8, count: 3, observe: 720 },
  { station: "Endgame", k: 1, boxSize: 16, count: 1, observe: 510 },
  { station: "Endgame", k: 1, boxSize: 16, count: 2, observe: 870 },
  { station: "Endgame", k: 1, boxSize: 24, count: 1, observe: 645 },
  { station: "Endgame", k: 1, boxSize: 24, count: 2, observe: 1139 },
  { station: "Endgame", k: 1, boxSize: 24, count: 3, observe: 1634 },
  { station: "Endgame", k: 1, boxSize: 32, count: 1, observe: 830 },
  { station: "Endgame", k: 1, boxSize: 32, count: 2, observe: 1509 },
  { station: "Endgame", k: 1, boxSize: 32, count: 3, observe: 2190 },
  // Admin — Ruin Station (Pyro) : même grille, k = 1,4.
  { station: "Ruin", k: 1.4, boxSize: 16, count: 1, observe: 711 },
  { station: "Ruin", k: 1.4, boxSize: 16, count: 2, observe: 1215 },
  { station: "Ruin", k: 1.4, boxSize: 24, count: 1, observe: 901 },
  { station: "Ruin", k: 1.4, boxSize: 24, count: 2, observe: 1593 },
  { station: "Ruin", k: 1.4, boxSize: 32, count: 1, observe: 1159 },
  { station: "Ruin", k: 1.4, boxSize: 32, count: 2, observe: 2111 },
  { station: "Ruin", k: 1.4, boxSize: 32, count: 3, observe: 3063 },
];
const ecartRelatif = (r) =>
  Math.abs(autoloadFee(r.boxSize * r.count, r.boxSize, r.k) - r.observe) / r.observe;

test("autoloadFee : les 18 relevés en jeu sont approchés à 3 % près", () => {
  assert.equal(RELEVES.length, 18, "les 18 relevés de la spec doivent tous être confrontés");
  for (const r of RELEVES) {
    const e = ecartRelatif(r);
    assert.ok(e <= 0.03, `${r.station} ${r.count}×${r.boxSize} SCU : écart ${(e * 100).toFixed(1)} %`);
  }
  // Garde anti-test-vide : la barre des 3 % ne doit pas être confortable. L'écart réel culmine à
  // 2,8 % — si un jour il tombait à zéro partout, c'est le modèle ou la fixture qui aurait bougé.
  const max = Math.max(...RELEVES.map(ecartRelatif));
  assert.ok(max > 0.02, `écart max ${(max * 100).toFixed(1)} % : la tolérance ne mesure plus rien`);
});

test("autoloadFee : k discrimine bien les deux stations (contre-épreuve)", () => {
  // Sans le coefficient de station, les relevés de Ruin sortent largement de la tolérance :
  // c'est ce qui prouve que k porte une information et n'est pas un paramètre décoratif.
  const ruin = RELEVES.filter((r) => r.station === "Ruin");
  const pire = Math.max(...ruin.map((r) => ecartRelatif({ ...r, k: 1 })));
  assert.ok(pire > 0.2, `Ruin au tarif Endgame ne dévie que de ${(pire * 100).toFixed(1)} %`);
});

test("autoloadFee : le fractionnement se paie", () => {
  // Relevé n°2 de la spec : 32 SCU en deux caisses de 16 coûtent plus cher qu'en une de 32.
  assert.ok(autoloadFee(32, 16, 1) > autoloadFee(32, 32, 1));
  assert.equal(autoloadFee(32, 16, 1) - autoloadFee(32, 32, 1), AUTOLOAD.perBox);
});

test("autoloadFee : 0 SCU -> aucun frais", () => {
  // La base de 150 facture une transaction, pas une visite : sans SCU chargé il n'y a pas de
  // transaction. Facturer la base à vide rendrait négatif le profit d'une route qu'on n'emprunte
  // pas — et pénaliserait les routes non bornées, où les SCU sont inconnus.
  assert.equal(autoloadFee(0, 32, 1), 0);
  assert.equal(autoloadFee(-5, 32, 1.4), 0);
  assert.equal(autoloadFee(null, 32, 1), 0);
});

test("autoloadFee : k = 0 -> aucun frais", () => {
  // k = 0 est le levier « ce terminal ne facture rien » (autoload absent, ou relevé à zéro).
  assert.equal(autoloadFee(96, 32, 0), 0);
  assert.equal(autoloadFee(96, 32, -1), 0);
});

test("autoloadFee : montant entier, jamais un flottant à afficher tel quel", () => {
  assert.equal(autoloadFee(32, 32, 1), AUTOLOAD.base + AUTOLOAD.perBox + AUTOLOAD.perScu * 32);
  for (const k of [1, 1.2, 1.4, 1.41]) {
    for (const scu of [1, 7, 32, 96, 123]) {
      const f = autoloadFee(scu, 32, k);
      assert.equal(f, Math.round(f), `${scu} SCU à k=${k} rend ${f}`);
    }
  }
});

test("autoloadFee : à volume égal, un terminal plus plafonné coûte plus cher", () => {
  // Corollaire direct de perBox : c'est ce qui justifie de descendre maxBox jusqu'ici plutôt que
  // de facturer partout sur des caisses de 32.
  const couts = [32, 24, 16, 8, 4, 2, 1].map((maxBox) => autoloadFee(96, maxBox, 1));
  for (let i = 1; i < couts.length; i++) {
    assert.ok(couts[i] > couts[i - 1], `plafonds décroissants : ${couts.join(" < ")}`);
  }
});

test("autoloadFee : à taille de caisse constante, le coût croît avec le volume", () => {
  // La croissance n'est PAS garantie SCU par SCU (31 SCU font 4 caisses, 32 une seule : le
  // fractionnement rend 31 plus cher que 32). Elle l'est à caisse constante, seul cas qui a un sens.
  let prec = 0;
  for (let caisses = 1; caisses <= 8; caisses++) {
    const f = autoloadFee(32 * caisses, 32, 1.2);
    assert.ok(f > prec, `${caisses} caisses coûtent ${f}, pas plus que ${prec}`);
    prec = f;
  }
  assert.ok(autoloadFee(31, 32, 1) > autoloadFee(32, 32, 1), "31 SCU en 4 caisses > 32 SCU en 1");
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

// Marché conçu pour opposer le prix au gain : « Cher » paie mieux au SCU mais n'a presque plus de
// capacité, « Vaste » paie un peu moins et prend toute la soute.
const MKT_DEMANDE = () => ({
  terminals: [
    { name: "Départ", system: "Stanton", planet: "Hurston", outpost: false }, // 0
    { name: "Cher", system: "Stanton", planet: "Crusader", outpost: false },  // 1
    { name: "Vaste", system: "Stanton", planet: "ArcCorp", outpost: false },  // 2
  ],
  commodities: [
    { name: "Gold", kind: "metal", illegal: false,
      buys: [[0, 50, 500, NOW, 5]],
      sells: [[1, 100, 5, NOW, 3], [2, 99, 500, NOW, 3]] },
  ],
});

test("enRouteDeals : la vente retenue est celle qui RAPPORTE le plus, pas celle au prix le plus haut", () => {
  // « Cher » plafonne à 5 SCU (demande 5) -> 5 × 50 = 250. « Vaste » prend les 96 SCU -> 96 × 49 = 4 704.
  // Retenir le prix le plus haut divise le gain par 19 : computeUnits plafonne ensuite par cette
  // demande, et la vraie destination a déjà été écartée en amont, donc elle n'apparaît nulle part.
  const f = { useCargo: true, cargo: 96, useBudget: false, budget: 0, capStock: true };
  const [d] = enRouteDeals(MKT_DEMANDE(), 0, "", null, f);
  assert.equal(d.sell.terminal, "Vaste");
  assert.equal(d.sell.demand, 500);
});

test("enRouteDeals : sans plafond de volume, le prix redevient le seul critère sensé", () => {
  // capStock inactif : computeUnits ignore stock et demande, donc toutes les destinations chargent
  // autant. À volume égal, le prix le plus haut EST l'optimum — et c'est le comportement d'origine.
  const f = { useCargo: true, cargo: 96, useBudget: false, budget: 0, capStock: false };
  assert.equal(enRouteDeals(MKT_DEMANDE(), 0, "", null, f)[0].sell.terminal, "Cher");
  assert.equal(enRouteDeals(MKT_DEMANDE(), 0, "")[0].sell.terminal, "Cher"); // sans f : inchangé
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

test("manifestsFrom : quand le BUDGET borne, l'ordre de remplissage ne laisse pas la soute vide", () => {
  // Remplir par marge décroissante n'est optimal que si la soute est la seule contrainte. Sous
  // budget, la ligne chère le draine d'abord : « Lourde » coûte 50 000/SCU, donc 2 SCU épuisent les
  // 100 000 et rapportent 20 000, soute à 2/96. « Légère » à 1 000/SCU remplit les 96 SCU pour
  // 864 000 — 43× plus, sur exactement les mêmes lignes candidates.
  const mkt = {
    terminals: [
      { name: "A", system: "Stanton", planet: "Hurston", outpost: false },
      { name: "B", system: "Stanton", planet: "Crusader", outpost: false },
    ],
    commodities: [
      { name: "Lourde", kind: "metal", illegal: false, buys: [[0, 50_000, 96, NOW, 5]], sells: [[1, 60_000, 999, NOW, 3]] },
      { name: "Légère", kind: "metal", illegal: false, buys: [[0, 1_000, 96, NOW, 5]], sells: [[1, 10_000, 999, NOW, 3]] },
    ],
  };
  const f = { useCargo: true, cargo: 96, useBudget: true, budget: 100_000, legalOnly: false, noOutpost: false, maxAge: 0 };
  const [t] = manifestsFrom(mkt, 0, "", f, idResolve);
  assert.equal(t.profit, 864_000);
  assert.equal(t.lines[0].name, "Légère");
  assert.equal(t.lines[0].units, 96);
});

test("manifestsFrom : sans budget bornant, le remplissage par marge reste inchangé", () => {
  // Soute seule contrainte -> le glouton par marge EST optimal, et on ne doit rien changer.
  const f = { useCargo: true, cargo: 100, useBudget: false, budget: 0, legalOnly: false, noOutpost: false, maxAge: 0 };
  const [t] = manifestsFrom(MKT(), 0, "", f, idResolve);
  assert.equal(t.lines[0].name, "Gold"); // marge 200 > Drug 30
});

test("buildChainAdjacency : à soute bornée, le segment retenu est celui qui REMPLIT, pas le plus margé", () => {
  // « Rare » marge 1 000 mais un seul SCU en stock -> 1 000 aUEC. « Vrac » marge 900 sur 96 SCU ->
  // 86 400. Garder le plus margé évince définitivement le bon segment du graphe : bestChain ne peut
  // plus le retrouver, puisqu'un seul segment survit par paire de terminaux.
  const mkt = {
    terminals: [
      { name: "A", system: "Stanton", planet: "Hurston", outpost: false },
      { name: "B", system: "Stanton", planet: "Crusader", outpost: false },
    ],
    commodities: [
      { name: "Rare", kind: "metal", illegal: false, buys: [[0, 100, 1, NOW, 5]], sells: [[1, 1100, 500, NOW, 3]] },
      { name: "Vrac", kind: "metal", illegal: false, buys: [[0, 100, 96, NOW, 5]], sells: [[1, 1000, 500, NOW, 3]] },
    ],
  };
  const f = { legalOnly: false, noOutpost: false, useCargo: true, cargo: 96 };
  assert.equal(buildChainAdjacency(mkt, f, idResolve).get(0)[0].commodity, "Vrac");
  // Sans soute bornée, aucun volume n'est calculable : la marge reste le seul critère disponible.
  const sansSoute = { legalOnly: false, noOutpost: false, useCargo: false, cargo: 0 };
  assert.equal(buildChainAdjacency(mkt, sansSoute, idResolve).get(0)[0].commodity, "Rare");
});

test("bestChain : le faisceau ne coupe pas un préfixe modeste qui mène au meilleur circuit", () => {
  // 60 sauts à 9 600 aUEC qui ne mènent nulle part, et un saut à 960 qui ouvre sur 960 000. Trié par
  // profit cumulé, le bon préfixe arrive 61e : un faisceau de 40 le décapite au premier saut et la
  // chaîne à 960 960 devient introuvable. C'est le mécanisme mesuré sur les vraies données, où
  // 39 origines sur 107 perdaient plus de 5 %, jusqu'à ×4,53.
  const adj = new Map();
  const impasses = Array.from({ length: 60 }, (_, i) => ({
    to: i + 1, commodity: `Impasse${i}`, kind: "metal", illegal: false,
    margin: 100, buyPrice: 10, sellPrice: 110, stock: 96, demand: 96, demandKnown: true, fee: null,
  }));
  adj.set(0, [...impasses, {
    to: 61, commodity: "Modeste", kind: "metal", illegal: false,
    margin: 10, buyPrice: 10, sellPrice: 20, stock: 96, demand: 96, demandKnown: true, fee: null,
  }]);
  adj.set(61, [{
    to: 62, commodity: "Jackpot", kind: "metal", illegal: false,
    margin: 10_000, buyPrice: 10, sellPrice: 10_010, stock: 96, demand: 96, demandKnown: true, fee: null,
  }]);
  assert.equal(bestChain(adj, 0, 2, { cargo: 96, beam: 40 }).profit, 9_600); // l'ancien défaut
  assert.equal(bestChain(adj, 0, 2, { cargo: 96 }).profit, 960_960);         // le faisceau par défaut
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

test("valueTiers : deux commodités au même prix portent le même palier", () => {
  // Cas réel du board : Neon et Dymantium se vendent tous deux 25 000 aUEC/SCU et encadrent
  // la frontière t-warm / t-mid. Deux tuiles de même valeur ne peuvent pas être de deux couleurs.
  const t = valueTiers([
    { name: "X", bestSell: 300 },
    { name: "Neon", bestSell: 200 },
    { name: "Dymantium", bestSell: 200 },
    { name: "Y", bestSell: 100 },
    { name: "Z", bestSell: 50 },
  ]);
  assert.equal(t.get("Neon"), t.get("Dymantium"));
});

test("valueTiers : des ex æquo qui changent d'ordre d'affichage ne recolorent pas le board", () => {
  // Le tableau reçu est déjà trié pour l'affichage : passer de « Revente » à « Code A→Z »
  // permute les ex æquo, ce qui ne doit rien changer aux paliers.
  const rows = (a, b) => [
    { name: "X", bestSell: 300 },
    { name: a, bestSell: 200 },
    { name: b, bestSell: 200 },
    { name: "Y", bestSell: 100 },
    { name: "Z", bestSell: 50 },
  ];
  const parValeur = valueTiers(rows("Neon", "Dymantium"));
  const parCode = valueTiers(rows("Dymantium", "Neon"));
  for (const nom of ["X", "Neon", "Dymantium", "Y", "Z"]) {
    assert.equal(parCode.get(nom), parValeur.get(nom), nom + " a changé de palier");
  }
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

// ---------- Manifeste : totaux (source unique) ----------
test("manifestTotals : somme profit/investissement/SCU sur les lignes", () => {
  const lines = [
    { units: 10, buyPrice: 5, margin: 3 },   // profit 30, invest 50
    { units: 4, buyPrice: 20, margin: 7 },   // profit 28, invest 80
  ];
  // `fees` est toujours rendu : sans contexte de frais il vaut 0 et `profit` reste le total brut.
  assert.deepEqual(manifestTotals(lines), { profit: 58, invest: 130, scu: 14, fees: 0 });
});

test("manifestTotals : liste vide -> zéros", () => {
  assert.deepEqual(manifestTotals([]), { profit: 0, invest: 0, scu: 0, fees: 0 });
});

test("manifestTotals : tolère units/margin/buyPrice manquants (carry-only)", () => {
  // Ligne « carry » : pas vendable ici -> margin null ; unité définie mais buyPrice absent.
  const lines = [{ units: 8, margin: null }, { units: 3, buyPrice: 10, margin: 2 }];
  assert.deepEqual(manifestTotals(lines), { profit: 6, invest: 30, scu: 11, fees: 0 });
});

// ---------- Manifeste : unités d'un ajout libre ----------
test("freeAddUnits : remplit l'espace libre, plafonné par le stock", () => {
  assert.equal(freeAddUnits(100, 40), 40);  // borné par la soute restante
  assert.equal(freeAddUnits(12, 40), 12);   // borné par le stock
});

test("freeAddUnits : au moins 1 SCU (ajout volontaire), même sans place", () => {
  assert.equal(freeAddUnits(0, 40), 1);     // stock nul -> quand même 1 (dépassement assumé)
  assert.equal(freeAddUnits(100, 0), 1);    // plus de place -> quand même 1
});

test("freeAddUnits : soute non bornée -> 1 SCU (pas de remplissage massif)", () => {
  assert.equal(freeAddUnits(Infinity, Infinity), 1);
  assert.equal(freeAddUnits(50, NaN), 1);   // cargoLeft inconnu (soute désactivée)
});

test("freeAddUnits : stock inconnu (rien à acheter sur place) -> 1 SCU", () => {
  // Régression du mode Butin : une commodité sans aucun point d'achat arrivait ici avec un stock
  // Infinity et remplissait toute la soute d'un fret introuvable au terminal de départ.
  assert.equal(freeAddUnits(Infinity, 96), 1);
  assert.equal(freeAddUnits(Infinity, 4), 1);
  // Un stock connu remplit toujours l'espace libre : comportement inchangé.
  assert.equal(freeAddUnits(500, 96), 96);
  assert.equal(freeAddUnits(50, 96), 50);
});

// ---------- Manifeste : assemblage d'une ligne ----------
test("manifestLine : ligne vendable (achat + vente résolus)", () => {
  const c = { name: "Gold", kind: "metal", illegal: false };
  const buy = { price: 100, vol: 500, ovol: false };
  const sell = { price: 160, vol: 300, ovol: true };
  const l = manifestLine(c, buy, sell, 111, 222, 25, 25);
  assert.equal(l.name, "Gold");
  assert.equal(l.buyPrice, 100);
  assert.equal(l.stock, 500);
  assert.equal(l.sellPrice, 160);
  assert.equal(l.demand, 300);
  assert.equal(l.demandKnown, true);   // ovol de la vente
  assert.equal(l.margin, 60);          // 160 - 100
  assert.equal(l.buyUpdated, 111);
  assert.equal(l.sellUpdated, 222);
  assert.equal(l.units, 25);
  assert.equal(l.cap, 25);
  assert.equal(l.carry, false);        // vendable -> pas carry
});

test("manifestLine : sans vente -> carry-only (margin 0, sellPrice null)", () => {
  const c = { name: "Waste", kind: "waste", illegal: false };
  const buy = { price: 8, vol: 40, ovol: false };
  const l = manifestLine(c, buy, null, 111, 0, 40, 40);
  assert.equal(l.sellPrice, null);
  assert.equal(l.demand, null);
  assert.equal(l.margin, 0);           // pas vendable ici -> profit ailleurs
  assert.equal(l.carry, true);
  assert.equal(l.stock, 40);
});

test("manifestLine : sans achat -> prix 0, stock Infinity (chargé d'ailleurs)", () => {
  const c = { name: "Loot", kind: "other", illegal: false };
  const l = manifestLine(c, null, { price: 50, vol: 10, ovol: false }, 0, 5, 1, 1);
  assert.equal(l.buyPrice, 0);
  assert.equal(l.stock, Infinity);
  assert.equal(l.margin, 50);          // 50 - 0
  assert.equal(l.carry, false);
});

test("manifestLine : `acquired` balise le côté ACHAT manquant, comme `carry` balise la vente", () => {
  // Sans ce drapeau, un butin (aucun point d'achat) affichait un prix d'achat « 0 » indiscernable
  // d'un vrai relevé UEX : le manifeste se lisait comme un achat gratuit sur place.
  const c = { name: "Quantainium", kind: "mineral", illegal: false };
  const sell = { price: 130000, vol: null, ovol: false };
  const buy = { price: 100, vol: 50, ovol: true };
  assert.equal(manifestLine(c, null, sell, 0, 5, 1, 1).acquired, true);
  assert.equal(manifestLine(c, buy, sell, 1, 2, 3, 3).acquired, false);
  // Les deux côtés peuvent manquer : trouvé ailleurs ET pas vendable ici.
  const both = manifestLine(c, null, null, 0, 0, 1, 1);
  assert.equal(both.acquired, true);
  assert.equal(both.carry, true);
  assert.equal(both.margin, 0);
});

// ---------- Résolution d'une commodité : le code UEX n'est PAS une clé unique ----------
const COMMS_DUP = [
  { name: "Copper", code: "COPP" },
  { name: "Copper (Ore)", code: "COPP" }, // UEX attribue le même code aux deux
  { name: "Laranite", code: "LARA" },
  { name: "Sans code", code: "" },
];

test("resolveCommodity : le nom exact prime sur le code", () => {
  assert.equal(resolveCommodity(COMMS_DUP, "Copper (Ore)").name, "Copper (Ore)");
  assert.equal(resolveCommodity(COMMS_DUP, "  copper  ").name, "Copper"); // casse et espaces ignorés
});

test("resolveCommodity : un code ambigu ne résout rien plutôt que de deviner", () => {
  assert.equal(resolveCommodity(COMMS_DUP, "LARA").name, "Laranite"); // code unique -> résout
  assert.equal(resolveCommodity(COMMS_DUP, "lara").name, "Laranite");
  // COPP désigne DEUX commodités : renvoyer la première rendait « Copper (Ore) » inatteignable.
  assert.equal(resolveCommodity(COMMS_DUP, "COPP"), null);
});

test("resolveCommodity : requête vide, nulle ou inconnue -> null", () => {
  assert.equal(resolveCommodity(COMMS_DUP, ""), null);
  assert.equal(resolveCommodity(COMMS_DUP, "   "), null);
  assert.equal(resolveCommodity(COMMS_DUP, null), null);
  assert.equal(resolveCommodity(COMMS_DUP, undefined), null);
  assert.equal(resolveCommodity(COMMS_DUP, "Inconnue"), null);
  assert.equal(resolveCommodity([], "Copper"), null);
});

test("ambiguousCodes : ne retient que les codes portés par PLUSIEURS commodités", () => {
  const dup = ambiguousCodes(COMMS_DUP);
  assert.equal(dup.has("COPP"), true);
  assert.equal(dup.has("LARA"), false);
  assert.equal(dup.has(""), false);      // code vide : jamais un doublon
  assert.equal(dup.size, 1);
  assert.equal(ambiguousCodes([]).size, 0);
});

// ---------- Libellé de station « Nom — Système » ----------
test("stationLabel / parseStationLabel : aller-retour", () => {
  assert.equal(stationLabel("Area18", "Stanton"), "Area18 — Stanton");
  assert.deepEqual(parseStationLabel("Area18 — Stanton"), { name: "Area18", system: "Stanton" });
});

test("parseStationLabel : coupe au PREMIER séparateur (nom prioritaire, comme l'ancien split[0])", () => {
  // Un nom contenant « — » : la partie avant le 1er séparateur reste le nom résolu.
  assert.equal(parseStationLabel("A — B — Pyro").name, "A");
});

test("parseStationLabel : sans séparateur -> system vide", () => {
  assert.deepEqual(parseStationLabel("JustAName"), { name: "JustAName", system: "" });
  assert.deepEqual(parseStationLabel(""), { name: "", system: "" });
});

// ---------- Sémantique UEX de la demande (capacité restante, pas le stock détenu) ----------
// UEX : `scu_sell` = capacité totale du terminal, `scu_sell_stock` = ce qu'il détient déjà.
// La demande exploitable = capacité restante. null = capacité inconnue ; 0 = saturé.
test("fillCargo : demande null (inconnue) ne plafonne pas, 0 (saturé) exclut la ligne", () => {
  const items = [
    { name: "Sature", buyPrice: 100, stock: 999, demand: 0, margin: 99 },    // meilleure marge mais plein
    { name: "Inconnu", buyPrice: 100, stock: 999, demand: null, margin: 10 },
  ];
  const { lines } = fillCargo(items, 50, Infinity);
  assert.deepEqual(lines.map((l) => l.name), ["Inconnu"]);
  assert.equal(lines[0].units, 50);      // non plafonné par la demande
});

test("addableUnits : demande null non plafonnante, 0 bloquante", () => {
  const rem = { cargoLeft: 80, budgetLeft: Infinity };
  assert.equal(addableUnits({ buyPrice: 10, stock: 999, demand: null }, rem), 80);
  assert.equal(addableUnits({ buyPrice: 10, stock: 999, demand: 0 }, rem), 0);
  assert.equal(addableUnits({ buyPrice: 10, stock: 999, demand: 30 }, rem), 30);
});

test("bestChain : un saut vers un terminal saturé (demande 0) est écarté", () => {
  const adj = new Map([
    [0, [
      { to: 1, commodity: "Sature", margin: 500, stock: 999, demand: 0 },   // plein -> inutilisable
      { to: 2, commodity: "Ok", margin: 10, stock: 999, demand: null },     // capacité inconnue -> ok
    ]],
  ]);
  const chain = bestChain(adj, 0, 1, { cargo: 100 });
  assert.equal(chain.legs.length, 1);
  assert.equal(chain.legs[0].commodity, "Ok"); // malgré une marge 50× plus faible
  assert.equal(chain.profit, 100 * 10);
});

// ---------- Trajets MULTI-COMMODITÉ : manifestsFrom / multiTrips / tripMetrics / legFromTrip ----------
// Soute 400 : Gold sature à 300 (demande en B) -> Drug complète les 100 SCU restants = vrai multi.
test("manifestsFrom : un manifeste par destination, trié par profit décroissant", () => {
  const trips = manifestsFrom(MKT(), 0, "", F({ useCargo: true, cargo: 400 }), idResolve);
  assert.equal(trips.length, 2);
  assert.equal(trips[0].dest.name, "C");            // 400 × 200 = 80 000
  assert.equal(trips[0].profit, 80_000);
  assert.equal(trips[1].dest.name, "B");            // 300 × 50 + 100 × 30 = 18 000
  assert.equal(trips[1].profit, 18_000);
});

test("manifestsFrom : la soute se remplit avec PLUSIEURS commodités quand la 1re sature", () => {
  const trips = manifestsFrom(MKT(), 0, "", F({ useCargo: true, cargo: 400 }), idResolve);
  const toB = trips.find((t) => t.dest.name === "B");
  assert.equal(toB.lines.length, 2);                       // Gold puis Drug
  assert.deepEqual(toB.lines.map((l) => l.name), ["Gold", "Drug"]); // marge décroissante
  assert.equal(toB.lines[0].units, 300);                   // plafonné par la demande en B
  assert.equal(toB.lines[1].units, 100);                   // complète les SCU restants
});

test("manifestsFrom : [] si la soute n'est pas bornée (rien à remplir)", () => {
  assert.deepEqual(manifestsFrom(MKT(), 0, "", F(), idResolve), []);
});

test("bestManifest reste le 1er de manifestsFrom (comportement inchangé)", () => {
  const f = F({ useCargo: true, cargo: 400 });
  assert.equal(bestManifest(MKT(), 0, "", f, idResolve).dest.name, manifestsFrom(MKT(), 0, "", f, idResolve)[0].dest.name);
});

test("multiTrips : ne garde que les chargements COMBINÉS (≥ 2 commodités)", () => {
  // Vers C, Gold seul sature les 400 SCU -> chargement à 1 commodité, déjà couvert par la vue
  // « Trajets » normale, donc écarté du mode multi.
  const trips = multiTrips(MKT(), F({ useCargo: true, cargo: 400 }), idResolve);
  assert.deepEqual(trips.map((t) => t.dest.name), ["B"]);
  assert.equal(trips[0].lines.length, 2);
});

test("multiTrips : minLines:1 rend aussi les chargements à une seule commodité", () => {
  const trips = multiTrips(MKT(), F({ useCargo: true, cargo: 400 }), idResolve, 300, 1);
  assert.equal(trips.length, 2);                    // seul A a des achats
  assert.equal(trips[0].dest.name, "C");            // trié par profit décroissant
  assert.ok(trips[0].profit >= trips[1].profit);
});

test("multiTrips : sameOnly écarte les sauts inter-système", () => {
  const trips = multiTrips(MKT(), F({ useCargo: true, cargo: 400, sameOnly: true }), idResolve, 300, 1);
  assert.deepEqual(trips.map((t) => t.dest.name), ["B"]); // C est dans Pyro
});

test("multiTrips : sysFilter s'applique au système d'ACHAT", () => {
  assert.equal(multiTrips(MKT(), F({ useCargo: true, cargo: 400, sysFilter: "Pyro" }), idResolve, 300, 1).length, 0);
  assert.equal(multiTrips(MKT(), F({ useCargo: true, cargo: 400, sysFilter: "Stanton" }), idResolve, 300, 1).length, 2);
});

test("multiTrips : q ne garde que les trajets contenant la commodité cherchée", () => {
  const trips = multiTrips(MKT(), F({ useCargo: true, cargo: 400, q: "drug" }), idResolve);
  assert.deepEqual(trips.map((t) => t.dest.name), ["B"]); // seul le chargement vers B contient Drug
});

test("multiTrips : legalOnly exclut les commodités illégales du chargement", () => {
  const f = F({ useCargo: true, cargo: 400, legalOnly: true });
  const toB = multiTrips(MKT(), f, idResolve, 300, 1).find((t) => t.dest.name === "B");
  assert.deepEqual(toB.lines.map((l) => l.name), ["Gold"]);   // Drug (illégal) écarté
  assert.equal(multiTrips(MKT(), f, idResolve).length, 0);    // réduit à 1 commodité -> hors mode multi
});

test("multiTrips : limit tronque la liste (garde-fou de perf)", () => {
  assert.equal(multiTrips(MKT(), F({ useCargo: true, cargo: 400 }), idResolve, 1, 1).length, 1);
});

test("tripMetrics : totaux, marge moyenne pondérée par SCU et ROI", () => {
  const toB = manifestsFrom(MKT(), 0, "", F({ useCargo: true, cargo: 400 }), idResolve)
    .find((t) => t.dest.name === "B");
  const m = tripMetrics(toB);
  assert.equal(m.units, 400);                        // 300 Gold + 100 Drug
  assert.equal(m.investment, 300 * 100 + 100 * 50);  // 35 000
  assert.equal(m.profit, 18_000);
  assert.equal(m.margin, 45);                        // 18 000 / 400 SCU
  assert.equal(m.roi, 51.4);                         // arrondi à 0,1 %
  assert.equal(m.nLines, 2);
  assert.equal(m.commodity, "Gold");                 // ligne de tête = plus grosse marge
  assert.equal(m.buyPrice, 87.5);                    // 35 000 / 400
  assert.equal(m.sellPrice, 132.5);                  // 87,5 + 45
});

test("tripMetrics : profit/heure intra-système (tripMinutes(0,false) = 6 min)", () => {
  const toB = manifestsFrom(MKT(), 0, "", F({ useCargo: true, cargo: 400 }), idResolve)
    .find((t) => t.dest.name === "B");
  const m = tripMetrics(toB);
  assert.equal(m.minutes, 6);
  assert.equal(m.profitHour, 18_000 * 60 / 6);
});

test("legFromTrip : jambe de voyage depuis un trajet multi (commodité de tête)", () => {
  const toB = manifestsFrom(MKT(), 0, "", F({ useCargo: true, cargo: 400 }), idResolve)
    .find((t) => t.dest.name === "B");
  const leg = legFromTrip({ ...toB, ...tripMetrics(toB) });
  assert.equal(leg.from, "A");
  assert.equal(leg.fromSystem, "Stanton");
  assert.equal(leg.to, "B");
  assert.equal(leg.commodity, "Gold");
  assert.equal(leg.margin, 45);            // marge moyenne du chargement
});

test("legFromManifest : la jambe porte la marge du chargement, sans passer par tripMetrics", () => {
  const toB = manifestsFrom(MKT(), 0, "", F({ useCargo: true, cargo: 400 }), idResolve)
    .find((t) => t.dest.name === "B");
  const leg = legFromManifest(toB);
  assert.deepEqual(Object.keys(leg).sort(), ["buyPrice", "commodity", "from", "fromSystem", "margin", "sellPrice", "to", "toSystem"]);
  assert.deepEqual([leg.from, leg.to, leg.commodity], ["A", "B", "Gold"]);
  assert.equal(leg.margin, 45); // un manifeste n'a pas de champ `margin` : sans le calcul, ce serait 0
  assert.deepEqual(leg, legFromTrip({ ...toB, ...tripMetrics(toB) })); // même jambe que la vue Trajets multi
});

test("legFromManifest : la marge reste BRUTE quand les frais d'autoload sont actifs", () => {
  // La jambe est persistée et voyage dans le permalien : une marge nette y survivrait à
  // l'extinction de l'interrupteur et se cumulerait avec les marges brutes des autres vues.
  const f = F({ useCargo: true, cargo: 400 });
  // Frais réels mais supportables : à k plus élevé, manifestsFrom écarte les lignes dont la
  // manutention mange la marge et le chargement disparaît — il n'y aurait plus rien à mesurer.
  const cher = () => ({ maxBox: 32, k: 0.1 });
  const toB = manifestsFrom(MKT(), 0, "", f, idResolve, null, cher).find((t) => t.dest.name === "B");
  const m = tripMetrics(toB);
  assert.ok(m.fees > 0, "fixture sans frais : le test ne prouverait rien");
  assert.ok(m.marginGross > m.margin, "la marge nette doit être plus basse que la brute");
  assert.equal(legFromManifest(toB).margin, m.marginGross);
});

test("legFromManifest : un chargement « vend ailleurs » ne produit ni NaN ni jambe cassée", () => {
  const man = { origin: { name: "A", system: "Stanton" }, dest: { name: "B", system: "Stanton" }, cross: false, cargo: 96, fee: null,
    lines: [{ name: "Butin", units: 10, buyPrice: 0, sellPrice: null, margin: 0, stock: null, demand: null, acquired: true }] };
  const leg = legFromManifest(man);
  assert.equal(leg.commodity, "Butin");
  assert.equal(leg.sellPrice, 0);   // `null` coercé, jamais NaN
  assert.equal(leg.margin, 0);
  assert.deepEqual(decodeJourney(encodeJourney(startJourney([leg]))).legs[0], leg); // survit au lien
});

// ---------- Manifeste -> voyage : ce que le parcours en cours autorise ----------
test("manifestJourneyState : sans voyage, on en démarre un", () => {
  assert.deepEqual(manifestJourneyState(null, { name: "A" }, { name: "B" }), { etat: "ajouter" });
});

test("manifestJourneyState : un chargement au départ de la FIN du parcours s'ajoute", () => {
  const j = parcours(["A", "B", "C", "D"], 1);
  assert.deepEqual(manifestJourneyState(j, { name: "D" }, { name: "E" }), { etat: "ajouter" });
  // Voyage « de zéro » : la fin, c'est le point de départ posé.
  assert.deepEqual(manifestJourneyState(startJourneyAt({ name: "Z", system: "S" }), { name: "Z" }, { name: "Y" }), { etat: "ajouter" });
});

test("manifestJourneyState : la jambe COURANTE n'est pas une incompatibilité", () => {
  // État par défaut après tout ▶ : syncViewsToJourney pré-remplit En route avec la station
  // courante, donc la carte affiche la jambe qu'on vient de choisir. Sans cet état, un clic
  // passerait par la branche REMPLACER d'addToJourney et réduirait le voyage à cette seule jambe.
  const j = parcours(["A", "B", "C", "D"], 1);
  assert.deepEqual(manifestJourneyState(j, { name: "B" }, { name: "C" }), { etat: "deja", leg: 1 });
  assert.deepEqual(manifestJourneyState(j, { name: "C" }, { name: "D" }), { etat: "deja", leg: 2 }); // autre jambe planifiée
});

test("manifestJourneyState : sur un parcours cyclique, le raccord PRIME sur « déjà »", () => {
  // A→B→A, arrivé au bout : le chargement A→B est un nouveau tour, pas la jambe 0 déjà faite.
  // C'est ce test qui verrouille l'ordre des branches ; il tombe si on cherche « déjà » en premier.
  const boucle = { legs: [jambe("A", "B"), jambe("B", "A")], current: 2 };
  assert.deepEqual(manifestJourneyState(boucle, { name: "A" }, { name: "B" }), { etat: "ajouter" });
});

test("manifestJourneyState : sinon conflit, en nommant la fin du parcours", () => {
  const r = manifestJourneyState(parcours(["A", "B"], 0), { name: "A" }, { name: "Z" });
  assert.deepEqual(r, { etat: "conflit", fin: "B" });
});

test("manifestJourneyState : une jambe venue d'un permalien reste reconnue", () => {
  // decodeJourney coerce les systèmes absents à "" : la comparaison ne doit porter que sur les noms.
  const j = decodeJourney(encodeJourney(startJourney([jambe("A", "B")])));
  assert.equal(manifestJourneyState(j, { name: "B" }, { name: "C" }).etat, "ajouter");
  assert.equal(manifestJourneyState(j, { name: "A" }, { name: "B" }).etat, "deja");
});

// ---------- Board Commodités : les corrections locales s'y appliquent aussi ----------
// Corrige le prix d'un point précis, laisse tout le reste intact (même contrat qu'effVals).
const corrigeur = (corrections) => (commodity, terminal, side, price, vol) => {
  const c = corrections[`${commodity}|${terminal}|${side}`];
  return { price: c && c.price != null ? c.price : price, vol: c && c.vol != null ? c.vol : vol, ovol: vol != null };
};

test("commoditySummaries : sans résolveur, les prix bruts d'UEX (comportement historique)", () => {
  const [gold] = commoditySummaries(MKT()).filter((c) => c.name === "Gold");
  assert.deepEqual([gold.bestBuy, gold.bestSell, gold.margin], [100, 300, 200]);
});

test("commoditySummaries : une correction de prix change la marge, donc le rang et la couleur", () => {
  // Le bug : on corrigeait le prix de vente dans un tableau, et la tuile de la commodité gardait
  // la marge d'UEX — board classé et colorié sur un chiffre qu'on venait de démentir.
  const r = corrigeur({ "Gold|C|sell": { price: 900 } });
  const [gold] = commoditySummaries(MKT(), {}, r).filter((c) => c.name === "Gold");
  assert.equal(gold.bestSell, 900);
  assert.equal(gold.margin, 800); // 900 - 100
});

test("commoditySummaries : corriger l'achat le moins cher rebat aussi la marge", () => {
  const r = corrigeur({ "Gold|A|buy": { price: 250 } });
  const [gold] = commoditySummaries(MKT(), {}, r).filter((c) => c.name === "Gold");
  assert.equal(gold.bestBuy, 250);
  assert.equal(gold.margin, 50); // 300 - 250
});

test("commodityPoints : les points affichent les valeurs corrigées ET se trient dessus", () => {
  // B paie 150, C paie 300 : « mieux payé d'abord » met C en tête. En corrigeant B à 500,
  // c'est B qui doit passer devant — sinon la liste s'ordonne sur un prix démenti.
  const brut = commodityPoints(MKT(), "Gold");
  assert.deepEqual(brut.sells.map((s) => s.terminal), ["C", "B"]);
  const p = commodityPoints(MKT(), "Gold", {}, corrigeur({ "Gold|B|sell": { price: 500 } }));
  assert.deepEqual(p.sells.map((s) => s.terminal), ["B", "C"]);
  assert.equal(p.sells[0].price, 500);
});

test("commodityPoints : une correction de volume passe aussi (stock et demande)", () => {
  const p = commodityPoints(MKT(), "Gold", {}, corrigeur({ "Gold|A|buy": { vol: 7 }, "Gold|B|sell": { vol: 3 } }));
  assert.equal(p.buys.find((b) => b.terminal === "A").stock, 7);
  assert.equal(p.sells.find((s) => s.terminal === "B").demand, 3);
});

// ---------- Gel des jambes quand un VOLUME est corrigé ----------
const CHARGEMENTS = [
  [{ name: "Copper", units: 59 }, { name: "Aluminum", units: 37 }], // jambe 0 : Megumi -> Rat's Nest
  [{ name: "Titanium", units: 96 }],                                 // jambe 1 : Rat's Nest -> Checkmate
];
// `jambe` est défini plus bas dans le fichier : on ne l'appelle donc pas à l'évaluation du module.
const jambeDe = (from, to) => ({ from, fromSystem: "S", to, toSystem: "S", commodity: "X", buyPrice: 1, sellPrice: 2, margin: 1 });
const PARCOURS = [jambeDe("Megumi", "Rat's Nest"), jambeDe("Rat's Nest", "Checkmate")];

test("legsToPin : seule la jambe qui ACHÈTE ce point est figée", () => {
  // Stock du Copper corrigé à Megumi : la jambe 0 en charge, elle garde ses SCU. La jambe 1 part
  // d'ailleurs et n'en dépend pas — la figer la marquerait pour rien.
  assert.deepEqual(legsToPin(PARCOURS, CHARGEMENTS, "Copper", "Megumi", "buy"), [0]);
  assert.deepEqual(legsToPin(PARCOURS, CHARGEMENTS, "Titanium", "Rat's Nest", "buy"), [1]);
});

test("legsToPin : une demande corrigée regarde l'ARRIVÉE, pas le départ", () => {
  assert.deepEqual(legsToPin(PARCOURS, CHARGEMENTS, "Copper", "Rat's Nest", "sell"), [0]);
  assert.deepEqual(legsToPin(PARCOURS, CHARGEMENTS, "Copper", "Megumi", "sell"), []); // Megumi n'est l'arrivée de personne
});

test("legsToPin : ni le mauvais terminal ni la mauvaise commodité ne figent quoi que ce soit", () => {
  assert.deepEqual(legsToPin(PARCOURS, CHARGEMENTS, "Copper", "Checkmate", "buy"), []);  // bon fret, mauvais bout
  assert.deepEqual(legsToPin(PARCOURS, CHARGEMENTS, "Gold", "Megumi", "buy"), []);        // bon bout, fret absent
  assert.deepEqual(legsToPin(PARCOURS, [[], []], "Copper", "Megumi", "buy"), []);         // chargements vides
  assert.deepEqual(legsToPin([], [], "Copper", "Megumi", "buy"), []);                     // aucun voyage
});

test("legsToPin : un même terminal réutilisé plus loin fige TOUTES les jambes concernées", () => {
  // Le joueur repasse par Megumi : les deux jambes qui y chargent du Copper sont déjà décidées.
  const boucle = [jambeDe("Megumi", "Rat's Nest"), jambeDe("Rat's Nest", "Megumi"), jambeDe("Megumi", "Checkmate")];
  const charges = [[{ name: "Copper", units: 59 }], [{ name: "Titanium", units: 96 }], [{ name: "Copper", units: 12 }]];
  assert.deepEqual(legsToPin(boucle, charges, "Copper", "Megumi", "buy"), [0, 2]);
});

test("manifestIntent : ne persiste QUE le nom et les SCU, dans l'ordre", () => {
  const lines = [
    { name: "Gold", units: 300, buyPrice: 100, sellPrice: 150, stock: 500, buyUpdated: 1, cap: 300 },
    { name: "Drug", units: 0, buyPrice: 50, sellPrice: 80 },   // 0 volontaire : doit survivre
    { name: "Butin", units: 999, cap: 10 },                     // au-delà du cap : conservé tel quel
  ];
  const intent = manifestIntent(lines);
  assert.deepEqual(intent, [{ name: "Gold", units: 300 }, { name: "Drug", units: 0 }, { name: "Butin", units: 999 }]);
  // Le test qui interdit toute fuite d'instantané de marché dans le store.
  for (const e of intent) assert.deepEqual(Object.keys(e), ["name", "units"]);
});

test("sameIntent : distingue longueur, nom et SCU", () => {
  const a = [{ name: "Gold", units: 300 }, { name: "Drug", units: 10 }];
  assert.equal(sameIntent(a, [{ name: "Gold", units: 300 }, { name: "Drug", units: 10 }]), true);
  assert.equal(sameIntent(a, [{ name: "Gold", units: 300 }]), false);                              // longueur
  assert.equal(sameIntent(a, [{ name: "Gold", units: 300 }, { name: "Butin", units: 10 }]), false); // nom
  assert.equal(sameIntent(a, [{ name: "Gold", units: 299 }, { name: "Drug", units: 10 }]), false);  // SCU
  assert.equal(sameIntent([], []), true);
});

test("manifeste intact : destination libre et destination forcée donnent le MÊME chargement", () => {
  // C'est l'invariant qui justifie de ne RIEN persister quand le manifeste n'a pas été touché :
  // legManifest, qui force le terminal d'arrivée, recalculera exactement ce que la carte affichait.
  const f = F({ useCargo: true, cargo: 400 });
  let compares = 0;
  for (let o = 0; o < REAL.terminals.length; o++) {
    const libre = bestManifest(REAL, o, "", f, idResolve);
    if (!libre) continue;
    const force = bestManifest(REAL, o, "", f, idResolve, libre.destIdx);
    compares++;
    assert.deepEqual(manifestIntent(force.lines), manifestIntent(libre.lines), `divergence depuis ${REAL.terminals[o].name}`);
  }
  assert.ok(compares > 10, `échantillon trop petit (${compares})`);
});

// ---------- Résolution confrontée aux VRAIES données ----------
// Le doublon de code COPP (Copper / Copper (Ore)) est entré dans data/market.json et a traversé la
// CI au vert, parce que toutes les fixtures de ce fichier tiennent en 1 à 3 commodités — un doublon
// y est structurellement impossible. Ces deux tests confrontent la résolution à l'instantané réel.
const REAL = JSON.parse(readFileSync(new URL("./data/market.json", import.meta.url), "utf8"));

test("resolveCommodity : toute commodité réelle est atteignable par son NOM", () => {
  // L'invariant que le doublon COPP avait cassé : « Copper (Ore) » était introuvable.
  assert.ok(REAL.commodities.length > 50, "instantané trop petit pour être significatif");
  for (const c of REAL.commodities) {
    const got = resolveCommodity(REAL.commodities, c.name);
    assert.ok(got, `${c.name} introuvable par son nom`);
    assert.equal(got.name, c.name);
  }
});

test("resolveCommodity : sur les vraies données, un code résout SSI il est unique", () => {
  const counts = new Map();
  for (const c of REAL.commodities) if (c.code) counts.set(c.code, (counts.get(c.code) || 0) + 1);
  assert.ok(counts.size > 50, "instantané trop petit pour être significatif");
  for (const [code, n] of counts) {
    const got = resolveCommodity(REAL.commodities, code);
    if (n === 1) assert.equal(got && got.code, code, `code unique ${code} non résolu`);
    else assert.equal(got, null, `code ambigu ${code} (${n} commodités) a désigné « ${got && got.name} »`);
  }
});

// ---------- Retrait d'un arrêt : le décalage de « je suis ici » ----------
const jambe = (from, to) => ({ from, fromSystem: "S", to, toSystem: "S", commodity: "X", buyPrice: 1, sellPrice: 2, margin: 1 });
const parcours = (names, current) => ({ legs: names.slice(0, -1).map((n, i) => jambe(n, names[i + 1])), current });

test("removeJourneyStop : retirer le PREMIER arrêt décale la position d'un cran", () => {
  // A→B→C, « je suis à B » (station 1). On retire A : stations = [B, C], B est maintenant l'index 0.
  const r = removeJourneyStop(parcours(["A", "B", "C"], 1), 0);
  assert.deepEqual(r.legs.map((l) => l.from + "→" + l.to), ["B→C"]);
  assert.equal(r.current, 0); // avant le correctif : 1, donc « je suis à C » — le saut n'était pas fait
  assert.deepEqual([r.removedFrom, r.removedCount, r.insertedCount], [0, 1, 0]);
});

test("removeJourneyStop : retirer un arrêt du MILIEU décale aussi", () => {
  // A→B→C→D, « je suis à C » (station 2). On retire B : stations = [A, C, D], C passe à l'index 1.
  const r = removeJourneyStop(parcours(["A", "B", "C", "D"], 2), 1, jambe("A", "C"));
  assert.deepEqual(r.legs.map((l) => l.from + "→" + l.to), ["A→C", "C→D"]);
  assert.equal(r.current, 1); // avant le correctif : 2, donc « je suis à D »
  assert.deepEqual([r.removedFrom, r.removedCount, r.insertedCount], [0, 2, 1]);
});

test("removeJourneyStop : un arrêt situé APRÈS la position ne la déplace pas", () => {
  const r = removeJourneyStop(parcours(["A", "B", "C", "D"], 1), 3);
  assert.equal(r.current, 1); // toujours à B
  assert.deepEqual(r.legs.map((l) => l.from + "→" + l.to), ["A→B", "B→C"]);
});

test("removeJourneyStop : retirer le DERNIER arrêt ramène la position dans les bornes", () => {
  const r = removeJourneyStop(parcours(["A", "B", "C"], 2), 2); // arrivé à C, on retire C
  assert.equal(r.current, 1);
  assert.equal(r.legs.length, 1);
});

test("removeJourneyStop : sur deux arrêts, retirer l'ARRIVÉE garde le départ", () => {
  // A→B, on clique ✕ sur B. Avant : les DEUX arrêts disparaissaient d'un coup (retour à null).
  const r = removeJourneyStop(parcours(["A", "B"], 0), 1);
  assert.deepEqual(r.legs, []);
  assert.deepEqual(r.start, { name: "A", system: "S" });
  assert.deepEqual(journeyStations(r), [{ name: "A", system: "S" }]); // le voyage vit encore, à A
  assert.equal(r.current, 0);
  assert.deepEqual([r.removedFrom, r.removedCount, r.insertedCount], [0, 1, 0]);
});

test("removeJourneyStop : sur deux arrêts, retirer le DÉPART garde l'arrivée", () => {
  const r = removeJourneyStop(parcours(["A", "B"], 0), 0);
  assert.deepEqual(r.legs, []);
  assert.deepEqual(r.start, { name: "B", system: "S" });
  assert.equal(journeyEnd(r).name, "B"); // c'est de là que repartira le prochain arrêt
});

test("removeJourneyStop : le survivant se raccorde comme un vrai départ", () => {
  // Le parcours réduit doit se comporter EXACTEMENT comme un startJourneyAt : une jambe qui
  // part de la station survivante l'ÉTEND, elle ne remplace pas le voyage.
  const r = removeJourneyStop(parcours(["A", "B"], 0), 1);
  const suite = addToJourney(r, [jambe("A", "C")]);
  assert.deepEqual(suite.legs.map((l) => l.from + "→" + l.to), ["A→C"]);
  assert.equal(decodeJourney(encodeJourney(r)).start.name, "A"); // survit au lien partageable
});

test("removeJourneyStop : retirer le dernier arrêt restant -> null (voyage effacé)", () => {
  const seul = removeJourneyStop(parcours(["A", "B"], 0), 1); // il ne reste que A
  assert.equal(removeJourneyStop(seul, 0), null);
  assert.equal(removeJourneyStop(startJourneyAt({ name: "A", system: "S" }), 0), null);
});

// ---------- Suggestions d'arrêts : mêmes filtres que la vue qui les affichera ----------
const MARCHE_ARRETS = {
  terminals: [
    { name: "Dépôt", system: "Stanton", planet: "P", outpost: false },  // 0 : départ du parcours
    { name: "Poste", system: "Stanton", planet: "P", outpost: true },   // 1 : avant-poste, même système
    { name: "Relais", system: "Pyro", planet: "Q", outpost: false },    // 2 : autre système
  ],
  commodities: [
    { name: "Poudre", code: "POUD", kind: "vice", illegal: true, buys: [[0, 100, 500, 9e9, 3]], sells: [[1, 400, 500, 9e9, 3]] },
    { name: "Ferraille", code: "FERR", kind: "metal", illegal: false, buys: [[0, 100, 500, 9e9, 3]], sells: [[2, 200, 500, 9e9, 3]] },
  ],
};
const filtres = (o = {}) => ({
  cargo: 96, budget: 1e6, useCargo: true, useBudget: true, capStock: false,
  sameOnly: false, noOutpost: false, legalOnly: false, sysFilter: "", maxAge: 0, q: "", ...o,
});
const terminaux = (sugs) => sugs.map((s) => s.terminal);

test("stopSuggestions : sans filtre, une entrée par destination, la meilleure marge d'abord", () => {
  const s = stopSuggestions(MARCHE_ARRETS, 0, filtres());
  assert.deepEqual(terminaux(s), ["Poste", "Relais"]); // 300 puis 100
  assert.equal(s[0].commodity, "Poudre");
});

test("stopSuggestions : ne propose JAMAIS un trajet que la vue refuse d'afficher", () => {
  // Le bug : « Frais/légales uniquement » coché, la boîte proposait quand même une commodité
  // illégale (Megumi → Devlin Scrap via WiDoW). L'arrêt s'ajoutait, puis sa jambe s'affichait
  // « aucun fret rentable » — bestManifest, lui, applique pairEligible.
  assert.deepEqual(terminaux(stopSuggestions(MARCHE_ARRETS, 0, filtres({ legalOnly: true }))), ["Relais"]);
  assert.deepEqual(terminaux(stopSuggestions(MARCHE_ARRETS, 0, filtres({ noOutpost: true }))), ["Relais"]);
  assert.deepEqual(terminaux(stopSuggestions(MARCHE_ARRETS, 0, filtres({ sameOnly: true }))), ["Poste"]);
  assert.deepEqual(terminaux(stopSuggestions(MARCHE_ARRETS, 0, filtres({ q: "ferraille" }))), ["Relais"]);
});

test("stopSuggestions : le menu « système d'achat » ne bride PAS les suggestions", () => {
  // Seule différence assumée avec routePasses : dans un parcours, l'origine est imposée par la
  // jambe précédente. La filtrer par le menu viderait la boîte dès qu'on regarde un autre système.
  assert.equal(stopSuggestions(MARCHE_ARRETS, 0, filtres({ sysFilter: "Pyro" })).length, 2);
});

test("bestLegBetween : la jambe suit les mêmes filtres, sinon null", () => {
  const l = bestLegBetween(MARCHE_ARRETS, 0, 1, filtres());
  assert.equal(l.commodity, "Poudre");
  assert.deepEqual([l.from, l.to, l.margin], ["Dépôt", "Poste", 300]);
  // Filtrée : l'appelant pose alors une jambe « à vide », cohérente avec son manifeste vide.
  assert.equal(bestLegBetween(MARCHE_ARRETS, 0, 1, filtres({ legalOnly: true })), null);
  assert.equal(bestLegBetween(MARCHE_ARRETS, 0, 2, filtres({ sameOnly: true })), null);
});

test("stopSuggestions : sur les vraies données, chaque suggestion passe routePasses", () => {
  const jeux = [filtres(), filtres({ legalOnly: true }), filtres({ noOutpost: true }), filtres({ sameOnly: true })];
  let vues = 0;
  for (const f of jeux) {
    for (let o = 0; o < REAL.terminals.length; o++) {
      for (const s of stopSuggestions(REAL, o, f)) {
        vues++;
        const d = enRouteDeals(REAL, o, "", null, f)
          .find((x) => x.sell.terminal === s.terminal && x.commodity === s.commodity);
        assert.ok(d, `suggestion ${s.terminal}/${s.commodity} introuvable dans les deals`);
        assert.ok(routePasses(d, { ...f, sysFilter: "" }), `suggestion filtrée par la vue : ${s.terminal} via ${s.commodity}`);
      }
    }
  }
  assert.ok(vues > 100, `instantané trop petit pour être significatif (${vues} suggestions)`);
});

// ---------- Lignes de manifeste : ajout libre et ré-hydratation ----------
const MARCHE = {
  terminals: [{ name: "A", system: "S", planet: "", outpost: false }, { name: "B", system: "S", planet: "", outpost: false }],
  commodities: [
    { name: "Laranite", code: "LARA", kind: "metal", illegal: false, buys: [[0, 100, 40, 111, 3]], sells: [[1, 250, 30, 222, 2]] },
    { name: "Quantainium", code: "QUAN", kind: "mineral", illegal: false, buys: [], sells: [[1, 130000, null, 333, 1]] },
  ],
};
const identite = (n, t, s, price, vol) => ({ price, vol, ovol: vol != null });
const cLara = MARCHE.commodities[0], cQuan = MARCHE.commodities[1];

test("freeManifestLine : remplit l'espace libre, plafonné par le stock", () => {
  const l = freeManifestLine(MARCHE, 0, 1, cLara, 96, identite);
  assert.equal(l.units, 40);      // stock 40 < 96 SCU libres
  assert.equal(l.buyPrice, 100);
  assert.equal(l.margin, 150);
  assert.equal(l.acquired, false);
});

test("freeManifestLine : un butin sans point d'achat part à 1 SCU et reste balisé", () => {
  const l = freeManifestLine(MARCHE, 0, 1, cQuan, 96, identite);
  assert.equal(l.units, 1);
  assert.equal(l.acquired, true);
  assert.equal(l.buyPrice, 0);
});

test("hydrateManifestLine : relit les prix du marché, ne fige rien", () => {
  const l = hydrateManifestLine(MARCHE, 0, 1, cLara, 7, identite);
  assert.equal(l.units, 7);       // seule l'intention de l'utilisateur est reprise
  assert.equal(l.buyPrice, 100);  // le reste vient du marché COURANT
  assert.equal(l.sellPrice, 250);
  assert.equal(l.buyUpdated, 111);
  assert.equal(l.sellUpdated, 222);
  assert.equal(l.cap, 30);        // min(stock 40, demande 30)
});

test("hydrateManifestLine : demande inconnue -> le stock seul plafonne", () => {
  assert.equal(hydrateManifestLine(MARCHE, 0, 1, cQuan, 24, identite).cap, Infinity); // ni achat ni demande connue
});

test("decodeJourney : rejette les jambes mal formées d'un permalien fabriqué", () => {
  // Le hash est partageable : son contenu peut venir d'un tiers. Avant, ces entrées produisaient
  // des jambes à `from: undefined` et faisaient tomber toute l'application au rendu.
  assert.equal(decodeJourney('{"l":[[]]}'), null);
  assert.equal(decodeJourney('{"l":[[1,2,3,4,5,6,7,8]]}'), null);        // types faux
  assert.equal(decodeJourney('{"l":[["A","S","","S","x",1,2,1]]}'), null); // `to` vide
  assert.equal(decodeJourney('{"c":0,"s":[42]}'), null);                   // départ non textuel
});

test("decodeJourney : normalise les champs optionnels et borne `current`", () => {
  const j = decodeJourney('{"c":3000000000,"l":[["A","S1","B","S2"]]}');
  assert.equal(j.legs.length, 1);
  assert.deepEqual([j.legs[0].fromSystem, j.legs[0].toSystem, j.legs[0].commodity], ["S1", "S2", ""]);
  assert.deepEqual([j.legs[0].buyPrice, j.legs[0].sellPrice, j.legs[0].margin], [0, 0, 0]);
  assert.equal(j.current, 1); // borné à legs.length ; `| 0` le rendait négatif (troncature 32 bits)
});

// ---------- Éligibilité partagée manifeste / suggestions ----------
const T_VILLE = { name: "Ville", system: "S", planet: "", outpost: false };
const T_POSTE = { name: "Poste", system: "S", planet: "", outpost: true };
// `pairEligible` n'accepte pas d'injection d'horloge (pairAge lit Date.now()) : on ancre donc les
// relevés sur MAINTENANT. Le test reste déterministe — « il y a 9 jours » est toujours plus vieux
// que la fenêtre « < 24 h », quelle que soit la date d'exécution.
const NOW_S = Math.floor(Date.now() / 1000);
const VIEUX = NOW_S - 9 * 86400, FRAIS = NOW_S - 3600;

test("pairEligible : la fraîcheur écarte un couple dont un relevé est trop vieux", () => {
  const c = { name: "X", illegal: false };
  const f = { maxAge: 1 }; // < 24 h
  assert.equal(pairEligible({}, c, T_VILLE, VIEUX, FRAIS), true);            // filtre inactif
  assert.equal(pairEligible(f, c, T_VILLE, FRAIS, FRAIS), true);
  assert.equal(pairEligible(f, c, T_VILLE, VIEUX, FRAIS), false);            // achat périmé
  assert.equal(pairEligible(f, c, T_VILLE, FRAIS, VIEUX), false);            // vente périmée
});

test("pairEligible : légales et avant-postes", () => {
  assert.equal(pairEligible({ legalOnly: true }, { illegal: true }, T_VILLE, 0, 0), false);
  assert.equal(pairEligible({ noOutpost: true }, { illegal: false }, T_POSTE, 0, 0), false);
  assert.equal(pairEligible({ noOutpost: true }, { illegal: false }, T_VILLE, 0, 0), true);
});

test("suggestionsFrom : une commodité hors fenêtre de fraîcheur n'est PAS suggérée", () => {
  // Régression : la boîte « Remplir les N SCU libres » ne filtrait que « légales », donc elle
  // proposait des commodités que le manifeste optimal venait d'écarter, et le clic les insérait.
  const market = {
    terminals: [T_VILLE, { name: "Dest", system: "S", planet: "", outpost: false }],
    commodities: [
      { name: "Frais", kind: "metal", illegal: false, buys: [[0, 100, 50, FRAIS, 3]], sells: [[1, 300, 40, FRAIS, 2]] },
      { name: "Perime", kind: "metal", illegal: false, buys: [[0, 100, 50, VIEUX, 3]], sells: [[1, 900, 40, FRAIS, 2]] },
    ],
  };
  const ctx = (f) => ({
    lines: [], originIdx: 0, destIdx: 1,
    origin: { name: "Ville", system: "S" }, dest: { name: "Dest", system: "S" }, f,
  });
  const id = (n, t, s, price, vol) => ({ price, vol, ovol: vol != null });

  // Sans filtre : les deux sortent, la plus margée d'abord.
  assert.deepEqual(suggestionsFrom(market, ctx({}), id).map((x) => x.name), ["Perime", "Frais"]);
  // Avec « relevé < 24 h » : la périmée disparaît, exactement comme du manifeste optimal.
  assert.deepEqual(suggestionsFrom(market, ctx({ maxAge: 1 }), id).map((x) => x.name), ["Frais"]);
});

test("suggestionsFrom : une commodité déjà chargée n'est pas re-suggérée", () => {
  const market = {
    terminals: [T_VILLE, { name: "Dest", system: "S", planet: "", outpost: false }],
    commodities: [{ name: "Frais", kind: "metal", illegal: false, buys: [[0, 100, 50, FRAIS, 3]], sells: [[1, 300, 40, FRAIS, 2]] }],
  };
  const m = { lines: [{ name: "Frais" }], originIdx: 0, destIdx: 1, origin: { name: "Ville", system: "S" }, dest: { name: "Dest", system: "S" }, f: {} };
  assert.deepEqual(suggestionsFrom(market, m, (n, t, s, price, vol) => ({ price, vol, ovol: true })), []);
});

// ---------- Frais d'autoload dans le moteur : le profit devient NET ----------
// Deux points de frais : l'ancrage Endgame (k = 1, caisses de 32) et une station à la fois plus
// chère et plus plafonnée — les deux seules variables qui font bouger une facture.
const PT_A = { maxBox: 32, k: 1 };
const PT_B = { maxBox: 16, k: 1.4 };

test("autoloadPoint : sans autoload le terminal ne facture rien mais garde son plafond de caisse", () => {
  assert.deepEqual(autoloadPoint({ name: "T", autoload: true, maxBox: 16 }, 1.4), { maxBox: 16, k: 1.4 });
  // k = 0 = « ne facture rien ». Le maxBox survit quand même : c'est encore ce terminal qui décide
  // de la taille des caisses, y compris quand c'est le joueur qui les empile à la main.
  assert.deepEqual(autoloadPoint({ name: "T", autoload: false, maxBox: 16 }, 1.4), { maxBox: 16, k: 0 });
  // Instantané de market.json antérieur au build qui ajoute les champs -> aucun frais, pas un crash.
  assert.deepEqual(autoloadPoint({ name: "T" }, 1.4), { maxBox: undefined, k: 0 });
  assert.equal(autoloadPoint(null, 1.4), null);
});

test("haulFee : deux opérations par chargement, chacune au tarif de SA station", () => {
  assert.equal(haulFee(32, { buy: PT_A, sell: PT_B }), autoloadFee(32, 32, 1) + autoloadFee(32, 32, 1.4));
  assert.equal(haulFee(32, null), 0);                             // interrupteur inactif
  assert.equal(haulFee(Infinity, { buy: PT_A, sell: PT_B }), 0);  // route non bornée : aucun volume
});

test("haulFee : les caisses sont faites au CHARGEMENT, pas au déchargement (hypothèse 1)", () => {
  // A caisse par 32, B par 16 : le SENS du trajet change donc la facture des DEUX opérations, car
  // rien ne re-caisse la cargaison en vol. C'est l'erreur que la signature rend impossible.
  const depuisA = haulFee(32, { buy: PT_A, sell: PT_B });
  const depuisB = haulFee(32, { buy: PT_B, sell: PT_A });
  assert.equal(depuisA, autoloadFee(32, 32, 1) + autoloadFee(32, 32, 1.4));
  assert.equal(depuisB, autoloadFee(32, 16, 1.4) + autoloadFee(32, 16, 1));
  assert.ok(depuisB > depuisA, `${depuisB} devrait dépasser ${depuisA} : deux caisses au lieu d'une`);
});

test("haulFee : un terminal sans autoload ne facture rien, l'autre extrémité paie quand même", () => {
  const sansService = { maxBox: 16, k: 0 };
  assert.equal(haulFee(32, { buy: sansService, sell: sansService }), 0);
  // Chargé à la main en A (16 SCU par caisse), déchargé par l'autoload de B : B facture, et il
  // facture DEUX caisses — celles qu'on lui apporte.
  assert.equal(haulFee(32, { buy: sansService, sell: PT_A }), autoloadFee(32, 16, 1));
});

// --- Trajets simples / En route (routeMetrics) ---
const M_ROUTE = { buyPrice: 100, buyStock: 500, sellDemand: 300, margin: 50, distance: 0, sameSystem: true, buyUpdated: NOW, sellUpdated: NOW };

test("routeMetrics : sans contexte le profit reste brut, avec contexte il paie deux opérations", () => {
  const f = F({ useCargo: true, cargo: 96 });
  const brut = routeMetrics(M_ROUTE, f);
  assert.equal(brut.profit, 96 * 50);       // valeur historique, au caractère près
  assert.equal(brut.fees, 0);
  const frais = haulFee(96, { buy: PT_A, sell: PT_B });
  const net = routeMetrics(M_ROUTE, f, { buy: PT_A, sell: PT_B });
  assert.equal(net.fees, frais);
  assert.equal(net.profit, 96 * 50 - frais);
  assert.ok(frais > 0 && net.profit < brut.profit, "les frais doivent réellement mordre");
  assert.equal(net.units, brut.units);                 // seul le profit bouge
  assert.equal(net.investment, brut.investment);       // les frais ne sont pas du capital immobilisé
  assert.equal(net.profitHour, (net.profit * 60) / 6); // le profit/heure suit le net, donc le tri aussi
  assert.ok(net.rawScore < brut.rawScore);             // et le score avec lui
});

test("routeMetrics : route non bornée -> aucun frais calculable (pas de volume connu)", () => {
  const r = routeMetrics(M_ROUTE, F(), { buy: PT_A, sell: PT_B });
  assert.equal(r.profit, null);
  assert.equal(r.fees, 0);
  assert.ok(r.rawScore > 0);   // le score reste assis sur la marge brute par SCU, comme avant
});

// --- Boucles (loopMetrics) ---
test("loopMetrics : QUATRE opérations, les caisses faites au départ de chaque jambe", () => {
  const out = { buyPrice: 100, stock: 500, demand: 300, margin: 50, updated: NOW };
  const back = { buyPrice: 80, stock: 400, demand: 200, margin: 30, updated: NOW };
  const f = F({ useCargo: true, cargo: 100 });
  const brut = loopMetrics(out, back, 0, false, f);
  assert.equal(brut.profit, 100 * 50 + 100 * 30);   // valeur historique
  assert.equal(brut.fees, 0);
  const aller = haulFee(100, { buy: PT_A, sell: PT_B });   // chargé en A, déchargé en B
  const retour = haulFee(100, { buy: PT_B, sell: PT_A });  // chargé en B, déchargé en A
  const net = loopMetrics(out, back, 0, false, f, { a: PT_A, b: PT_B });
  assert.equal(net.fees, aller + retour);
  assert.equal(net.profit, brut.profit - aller - retour);
  // Non vacuisant : si les deux jambes coûtaient pareil, inverser les paires ne se verrait pas.
  assert.ok(aller !== retour, `aller ${aller} et retour ${retour} devraient différer`);
  assert.ok(net.profit < brut.profit);
});

// --- Manifeste (manifestTotals) ---
test("manifestTotals : une transaction PAR COMMODITÉ, à volume total identique (hypothèse 2)", () => {
  const pair = { buy: PT_A, sell: PT_A };
  const ligne = (units) => ({ units, buyPrice: 10, margin: 100 });
  const t1 = manifestTotals([ligne(96)], pair);
  const t3 = manifestTotals([ligne(32), ligne(32), ligne(32)], pair);
  assert.equal(t1.scu, t3.scu);                          // même volume, même fret
  // Deux commodités de plus = deux transactions de plus, facturées à CHAQUE extrémité.
  assert.equal(t3.fees - t1.fees, 2 * 2 * AUTOLOAD.base);
  assert.equal(t3.profit, 96 * 100 - t3.fees);
  assert.equal(t3.invest, 96 * 10);                      // l'investissement, lui, ne bouge pas
  assert.equal(manifestTotals([ligne(32), ligne(32), ligne(32)]).profit, 96 * 100); // sans contexte : brut
});

// --- Lignes qui ne subissent QU'UNE opération (carry / acquired) ---
const C_LIBRE = { name: "Fret", kind: "metal", illegal: false };
const PRIX = (price, vol) => ({ price, vol, ovol: false });

test("manifestTotals : une ligne « vend ailleurs » paie le chargement, jamais un déchargement", () => {
  // Par définition (manifestLine), cette ligne est chargée ici pour être écoulée PLUS LOIN : elle
  // reste en soute à l'arrivée. Lui facturer les deux opérations doublait son coût, et comme sa
  // colonne profit affiche « — », le total baissait sans qu'aucune ligne ne le montre.
  const carry = manifestLine(C_LIBRE, PRIX(100, 500), null, NOW, 0, 32, 32);
  assert.equal(carry.carry, true);
  assert.equal(carry.sellPrice, null);
  const t = manifestTotals([carry], { buy: PT_A, sell: PT_B });
  assert.equal(t.fees, autoloadFee(32, 32, 1));                    // le seul chargement, en A
  assert.notEqual(t.fees, haulFee(32, { buy: PT_A, sell: PT_B })); // contre-épreuve : pas deux
  assert.equal(t.profit, -t.fees);   // marge nulle ici : la ligne ne coûte QUE sa manutention
  assert.equal(t.scu, 32);
  assert.equal(t.invest, 32 * 100);  // elle est bien achetée : le capital, lui, est immobilisé
});

test("manifestTotals : une ligne « acquis ailleurs » paie le déchargement, jamais un chargement", () => {
  // Symétrique : butin, minage ou salvage — le fret était DÉJÀ en soute, l'autoload du terminal de
  // départ ne l'a jamais chargé (il ne s'y vend même pas).
  const acquis = manifestLine(C_LIBRE, null, PRIX(500, 500), 0, NOW, 32, 32);
  assert.equal(acquis.acquired, true);
  assert.equal(acquis.margin, 500);
  const t = manifestTotals([acquis], { buy: PT_A, sell: PT_B });
  assert.equal(t.fees, autoloadFee(32, 32, 1.4));  // le seul déchargement, en B…
  // …mais caissé au plafond du CHARGEMENT (hypothèse 1) : c'est aussi ce que le « 📦 » affiche.
  assert.equal(t.fees, lineHaulFee(32, acquis, { buy: PT_A, sell: PT_B }));
  assert.equal(t.profit, 32 * 500 - t.fees);
  assert.equal(t.invest, 0);                       // rien n'a été acheté ici
});

test("lineHaulFee : une ligne ordinaire paie les deux opérations, et rien ne change sans contexte", () => {
  const ordinaire = manifestLine(C_LIBRE, PRIX(100, 500), PRIX(300, 500), NOW, NOW, 32, 32);
  assert.equal(ordinaire.carry, false);
  assert.equal(ordinaire.acquired, false);
  assert.equal(lineHaulFee(32, ordinaire, { buy: PT_A, sell: PT_B }), haulFee(32, { buy: PT_A, sell: PT_B }));
  // Une ligne sans les deux bouts (ni achat ni vente ici) ne manutentionne rien du tout.
  const nulle = manifestLine(C_LIBRE, null, null, 0, 0, 32, 32);
  assert.equal(lineHaulFee(32, nulle, { buy: PT_A, sell: PT_B }), 0);
  // Interrupteur inactif : aucune de ces lignes ne coûte quoi que ce soit.
  for (const l of [ordinaire, nulle]) assert.equal(lineHaulFee(32, l, null), 0);
  assert.equal(manifestTotals([ordinaire]).fees, 0);
});

// --- Marché : le classement suit le net (manifestsFrom / bestManifest / multiTrips / chaîne) ---
// Marché taillé pour le classement NET : une commodité, deux destinations aux profits BRUTS très
// proches, dont la mieux payée décharge dans une station qui facture le double du tarif d'ancrage.
// Sans frais elle gagne ; avec, elle perd. C'est exactement ce que la fonctionnalité promet.
const TERM_NET = (name) => ({ name, system: "Pyro", planet: "", outpost: false, autoload: true, maxBox: 32 });
const MKT_NET = () => ({
  terminals: [TERM_NET("Depart"), TERM_NET("Cher"), TERM_NET("Sobre")],
  commodities: [
    { name: "Fret", kind: "metal", illegal: false,
      buys: [[0, 100, 100, NOW, 5]],
      sells: [[1, 200, 100, NOW, 3], [2, 195, 100, NOW, 3]] },
  ],
});
const K_NET = { Depart: 1, Cher: 2, Sobre: 1 };
const feeNet = (t) => autoloadPoint(t, K_NET[t.name]);
const OP1 = autoloadFee(100, 32, 1);   // une opération de 100 SCU au tarif d'ancrage
const OP2 = autoloadFee(100, 32, 2);   // la même à « Cher »

test("manifestsFrom : la destination gagnante suit le profit NET, pas le brut", () => {
  const f = F({ useCargo: true, cargo: 100 });
  const brut = manifestsFrom(MKT_NET(), 0, "", f, idResolve);
  assert.deepEqual(brut.map((t) => t.dest.name), ["Cher", "Sobre"]);  // 10 000 > 9 500
  assert.equal(brut[0].profit, 10_000);
  assert.equal(brut[0].fee, null);
  const net = manifestsFrom(MKT_NET(), 0, "", f, idResolve, null, feeNet);
  assert.deepEqual(net.map((t) => t.dest.name), ["Sobre", "Cher"]);   // le classement s'inverse
  assert.equal(net[0].profit, 9_500 - 2 * OP1);
  assert.equal(net[1].profit, 10_000 - OP1 - OP2);
  assert.ok(net[0].profit > net[1].profit);
  // bestManifest hérite de ce tri : c'est lui que consomment « En route » et les jambes de voyage.
  assert.equal(bestManifest(MKT_NET(), 0, "", f, idResolve, null, feeNet).dest.name, "Sobre");
  assert.equal(bestManifest(MKT_NET(), 0, "", f, idResolve).dest.name, "Cher");
});

test("enRouteDeals : la destination retenue suit le profit NET quand les frais sont actifs", () => {
  // enRouteDeals ne garde qu'UNE vente par commodité : choisie sur le prix affiché, la meilleure en
  // net n'entrait jamais dans la liste, et le tableau montrait une destination pendant que la carte
  // Manifeste du même écran (bestManifest, qui tranche déjà sur le net) en affichait une autre.
  const f = F({ useCargo: true, cargo: 100 });
  const brut = enRouteDeals(MKT_NET(), 0, "");
  assert.deepEqual(brut.map((d) => d.sell.terminal), ["Cher"]);      // 200 > 195
  const net = enRouteDeals(MKT_NET(), 0, "", null, f, feeNet);
  assert.deepEqual(net.map((d) => d.sell.terminal), ["Sobre"]);      // 9 500 − 2 opérations > 10 000 − 1 − 2×k
  // Non vacuisant : c'est bien le net qui départage, et il départage dans l'autre sens.
  assert.ok(100 * 95 - 2 * OP1 > 100 * 100 - OP1 - OP2);
  // Et c'est la MÊME destination que celle du manifeste affiché juste au-dessus.
  assert.equal(bestManifest(MKT_NET(), 0, "", f, idResolve, null, feeNet).dest.name, net[0].sell.terminal);
});

test("enRouteDeals : sans contexte de frais, le critère reste le prix de vente le plus élevé", () => {
  // Le garde-fou de non-régression : l'interrupteur inactif ne doit RIEN changer à cette vue.
  const f = F({ useCargo: true, cargo: 100 });
  assert.deepEqual(enRouteDeals(MKT(), 0, "", null, f).map((d) => d.sell.terminal), ["C", "B"]);
  assert.deepEqual(enRouteDeals(MKT(), 0, ""), enRouteDeals(MKT(), 0, "", null, f, null));
  // Une commodité dont AUCUNE vente ne bat le prix d'achat reste absente, frais ou pas.
  const perdant = {
    terminals: [TERM_NET("Depart"), TERM_NET("Sobre")],
    commodities: [{ name: "Fret", kind: "metal", illegal: false, buys: [[0, 300, 100, NOW, 5]], sells: [[1, 200, 100, NOW, 3]] }],
  };
  assert.deepEqual(enRouteDeals(perdant, 0, ""), []);
  assert.deepEqual(enRouteDeals(perdant, 0, "", null, f, feeNet), []);
});

test("tripMetrics : le trajet emporte son contexte de frais ; profit et profit/heure suivent", () => {
  const f = F({ useCargo: true, cargo: 100 });
  const [gagnant] = manifestsFrom(MKT_NET(), 0, "", f, idResolve, null, feeNet);
  const frais = 2 * OP1;
  const m = tripMetrics(gagnant);
  assert.equal(m.fees, frais);
  assert.equal(m.profit, 9_500 - frais);
  assert.equal(m.profitHour, ((9_500 - frais) * 60) / 6);
  assert.equal(m.investment, 100 * 100);                    // inchangé : les frais ne sont pas du fret
  // Contre-épreuve : le même chargement sans son contexte reste chiffré au brut.
  const brut = tripMetrics({ ...gagnant, fee: null });
  assert.equal(brut.fees, 0);
  assert.equal(brut.profit, 9_500);
  assert.ok(m.profit < brut.profit);
});

test("tripMetrics : marge et ROI sont NETS des frais, mais la jambe de voyage garde la marge de marché", () => {
  // Ce que le joueur encaisse par SCU, pas l'écart de prix affiché aux terminaux : marge et ROI
  // suivent le profit net. La jambe, elle, est PERSISTÉE et voyage dans le permalien `j=` — y figer
  // une marge nette la ferait survivre à l'extinction de l'interrupteur, mêlée à des marges brutes.
  const f = F({ useCargo: true, cargo: 100 });
  const [gagnant] = manifestsFrom(MKT_NET(), 0, "", f, idResolve, null, feeNet);
  const m = tripMetrics(gagnant);
  const brut = tripMetrics({ ...gagnant, fee: null });
  assert.ok(m.fees > 0, "sans frais facturés le test ne prouverait rien");
  assert.equal(brut.margin, 95);                        // 195 − 100, prix de marché
  assert.equal(m.margin, m.profit / m.units);           // net : profit amputé des frais, par SCU
  assert.ok(m.margin < brut.margin, "la marge nette doit être strictement sous la marge de marché");
  assert.equal(m.roi, Math.round((m.profit / m.investment) * 1000) / 10);
  assert.ok(m.roi < brut.roi);
  // La marge de MARCHÉ reste disponible, et c'est elle que la jambe de voyage retient.
  assert.equal(m.marginGross, 95);
  assert.equal(legFromTrip({ ...gagnant, ...m }).margin, 95);
  // Sans frais, les deux notions se confondent : aucune régression quand l'interrupteur est éteint.
  assert.equal(brut.margin, brut.marginGross);
  assert.equal(legFromTrip({ ...gagnant, ...brut }).margin, 95);
});

test("netMarginRoi : les frais se répartissent sur le volume, sauf s'il n'y a rien à répartir", () => {
  // 10 SCU, marge de marché 500/SCU, 1 000 aUEC de frais -> 100/SCU à retrancher.
  assert.deepEqual(netMarginRoi(500, 1_000, 10, 1_000), { margin: 400, roi: 40 });
  // Le ROI net se déduit bien de la marge nette : 400/1 000 = 40 %, et non 50 %.
  assert.notEqual(netMarginRoi(500, 1_000, 10, 1_000).roi, netMarginRoi(500, 1_000, 10, 0).roi);
  // Sans frais : exactement la marge de marché et l'ancien ROI (non-régression, interrupteur éteint).
  assert.deepEqual(netMarginRoi(500, 1_000, 10, 0), { margin: 500, roi: 50 });
  // Route non bornée : aucun volume sur quoi étaler un coût fixe -> valeurs de marché intactes.
  assert.deepEqual(netMarginRoi(500, 1_000, null, 1_000), { margin: 500, roi: 50 });
  // Prix d'achat nul (butin) : pas de division par zéro.
  assert.deepEqual(netMarginRoi(500, 0, 10, 1_000), { margin: 400, roi: 0 });
});

test("multiTrips : le tri ET la troncature portent sur le net (le garde-fou coupait sur le brut)", () => {
  const f = F({ useCargo: true, cargo: 100 });
  // limit 1 : un seul trajet survit au garde-fou de perf — ce doit être le meilleur en NET, sans
  // quoi le tableau ne contiendrait même pas la ligne que l'utilisateur cherche.
  assert.deepEqual(multiTrips(MKT_NET(), f, idResolve, 1, 1).map((t) => t.dest.name), ["Cher"]);
  assert.deepEqual(multiTrips(MKT_NET(), f, idResolve, 1, 1, feeNet).map((t) => t.dest.name), ["Sobre"]);
});

test("manifestsFrom : une commodité dont les frais dépassent la marge reste au sol", () => {
  // « Maigre » : 100 SCU à marge 5 rapportent 500 et coûtent deux fois OP1. La charger ferait
  // passer ce manifeste derrière un manifeste qui, lui, l'aurait laissée à quai.
  const mkt = () => ({
    terminals: [TERM_NET("Depart"), TERM_NET("Sobre")],
    commodities: [
      { name: "Riche", kind: "metal", illegal: false, buys: [[0, 100, 50, NOW, 5]], sells: [[1, 300, 50, NOW, 3]] },
      { name: "Maigre", kind: "metal", illegal: false, buys: [[0, 100, 100, NOW, 5]], sells: [[1, 105, 100, NOW, 3]] },
    ],
  });
  const f = F({ useCargo: true, cargo: 200 });
  const brut = manifestsFrom(mkt(), 0, "", f, idResolve)[0];
  assert.deepEqual(brut.lines.map((l) => l.name), ["Riche", "Maigre"]); // sans frais, on prend tout
  assert.equal(brut.profit, 50 * 200 + 100 * 5);
  const net = manifestsFrom(mkt(), 0, "", f, idResolve, null, feeNet)[0];
  assert.deepEqual(net.lines.map((l) => l.name), ["Riche"]);
  assert.equal(net.profit, 50 * 200 - 2 * autoloadFee(50, 32, 1));
  // Contre-épreuve chiffrée : c'est bien parce que ses 500 aUEC de marge ne couvrent pas ses deux
  // opérations d'autoload que « Maigre » reste à quai — pas parce qu'elle serait filtrée ailleurs.
  assert.ok(100 * 5 < 2 * OP1, `500 de marge devrait rester sous ${2 * OP1} de frais`);
});

test("buildChainAdjacency : estampille sur chaque saut les frais de ses DEUX terminaux", () => {
  const f = { legalOnly: false, noOutpost: false };
  const sans = buildChainAdjacency(MKT_NET(), f, idResolve);
  assert.equal(sans.get(0)[0].fee, null);           // interrupteur inactif : rien d'estampillé
  const avec = buildChainAdjacency(MKT_NET(), f, idResolve, feeNet);
  const versCher = avec.get(0).find((l) => l.to === 1);
  assert.deepEqual(versCher.fee, { buy: { maxBox: 32, k: 1 }, sell: { maxBox: 32, k: 2 } });
  // Et bestChain chiffre net sans jamais voir un terminal : il ne lit que ce que porte le leg.
  assert.deepEqual(bestChain(sans, 0, 1, { cargo: 100 }).path, [0, 1]);  // brut : « Cher » paie mieux
  const r = bestChain(avec, 0, 1, { cargo: 100 });
  assert.deepEqual(r.path, [0, 2]);                                      // net : « Sobre » l'emporte
  assert.equal(r.profit, 100 * 95 - 2 * OP1);
});

test("buildChainAdjacency : les frais peuvent renverser le choix de commodité d'un saut", () => {
  // Le segment se choisit déjà sur le gain RÉALISABLE, stock compris. Les frais ajoutent une couche
  // que le gain brut ne voit pas : la manutention se paie au volume, donc elle pénalise la grosse
  // cargaison bien plus que la petite. « Grosse » rapporte davantage brut (96 × 60 = 5 760 contre
  // 8 × 400 = 3 200) mais paie deux opérations de 96 SCU ; nette, elle passe DERRIÈRE « Petite ».
  const mkt = () => ({
    terminals: [TERM_NET("Depart"), TERM_NET("Sobre")],
    commodities: [
      { name: "Grosse", kind: "metal", illegal: false, buys: [[0, 100, 96, NOW, 5]], sells: [[1, 160, 999, NOW, 3]] },
      { name: "Petite", kind: "metal", illegal: false, buys: [[0, 100, 8, NOW, 5]], sells: [[1, 500, 999, NOW, 3]] },
    ],
  });
  const f = { legalOnly: false, noOutpost: false, useCargo: true, cargo: 96 };
  const brutGrosse = 96 * 60, brutPetite = 8 * 400;
  const netGrosse = brutGrosse - 2 * autoloadFee(96, 32, 1);
  const netPetite = brutPetite - 2 * autoloadFee(8, 32, 1);
  // Non vacuisant : les frais doivent VRAIMENT inverser l'ordre, sinon le test ne prouve rien.
  assert.ok(brutGrosse > brutPetite && netGrosse < netPetite, "la fixture doit inverser le classement");

  // Sans frais : le gain réalisable départage, donc la grosse cargaison.
  assert.equal(buildChainAdjacency(mkt(), f, idResolve).get(0)[0].commodity, "Grosse");
  assert.equal(bestChain(buildChainAdjacency(mkt(), f, idResolve), 0, 1, { cargo: 96 }).profit, brutGrosse);
  // Avec frais : la manutention renverse le classement.
  const avec = buildChainAdjacency(mkt(), f, idResolve, feeNet);
  assert.equal(avec.get(0)[0].commodity, "Petite");
  const chaine = bestChain(avec, 0, 1, { cargo: 96 });
  assert.ok(chaine, "un saut rentable ne doit pas disparaître du graphe");
  assert.equal(chaine.profit, netPetite);
});

test("buildChainAdjacency : sans soute bornée, le classement reste la marge (aucun volume calculable)", () => {
  const f = { legalOnly: false, noOutpost: false }; // ni useCargo ni cargo
  const adj = buildChainAdjacency(MKT(), f, idResolve, feeNet);
  assert.equal(adj.get(0).find((l) => l.to === 1).commodity, "Gold"); // marge 50 > Drug 30
});

// Chaîne : deux itinéraires A->…->D aux profits BRUTS proches, dont le mieux payé transite par une
// station qui facture trois fois le tarif d'ancrage. Les frais sont posés sur le leg, exactement
// comme le fait buildChainAdjacency.
const PT_K3 = { maxBox: 32, k: 3 };
const legF = (to, margin, fee = null) => ({ to, margin, stock: 999, demand: 999, buyPrice: 100, fee });
const CHAINE = (frais) => new Map([
  ["A", [legF("B", 300, frais ? { buy: PT_A, sell: PT_K3 } : null),
         legF("C", 290, frais ? { buy: PT_A, sell: PT_A } : null)]],
  ["B", [legF("D", 100, frais ? { buy: PT_K3, sell: PT_A } : null)]],
  ["C", [legF("D", 100, frais ? { buy: PT_A, sell: PT_A } : null)]],
  ["D", []],
]);

test("bestChain : deux opérations par saut, et l'itinéraire retenu suit le net", () => {
  const brut = bestChain(CHAINE(false), "A", 2, { cargo: 50 });
  assert.deepEqual(brut.path, ["A", "B", "D"]);        // (300 + 100) × 50
  assert.equal(brut.profit, 20_000);
  const parOp = autoloadFee(50, 32, 1);
  const net = bestChain(CHAINE(true), "A", 2, { cargo: 50 });
  assert.deepEqual(net.path, ["A", "C", "D"]);         // B facture trois fois le tarif d'ancrage
  assert.equal(net.legs[0].profit, 290 * 50 - 2 * parOp);
  assert.equal(net.profit, (290 + 100) * 50 - 4 * parOp);
  assert.ok(net.profit < brut.profit, "les frais doivent réellement mordre");
});

test("bestChain : un saut dont les frais mangent la marge est écarté, comme un saut sans marge", () => {
  // 50 SCU à marge 40 rapportent 2 000 et coûtent deux fois 1 240 : le saut fait perdre de l'argent.
  const perdant = new Map([["A", [legF("B", 40, { buy: PT_A, sell: PT_A })]], ["B", []]]);
  assert.equal(bestChain(perdant, "A", 1, { cargo: 50 }), null);
  const gratuit = new Map([["A", [legF("B", 40)]], ["B", []]]);
  assert.equal(bestChain(gratuit, "A", 1, { cargo: 50 }).profit, 2_000); // contre-épreuve sans frais
});

test("interrupteur inactif : aucune fonction de métriques ne facture quoi que ce soit", () => {
  // Le garde-fou de l'existant : sans contexte, les six vues rendent EXACTEMENT leurs valeurs d'avant.
  const f = F({ useCargo: true, cargo: 100 });
  assert.equal(routeMetrics(M_ROUTE, f).fees, 0);
  const seg = { buyPrice: 100, stock: 500, demand: 300, margin: 50, updated: NOW };
  assert.equal(loopMetrics(seg, seg, 0, false, f).fees, 0);
  const t = manifestsFrom(MKT_NET(), 0, "", f, idResolve)[0];
  assert.equal(t.fee, null);
  assert.equal(t.profit, 10_000);
  assert.equal(tripMetrics(t).fees, 0);
  assert.equal(manifestTotals(t.lines).fees, 0);
  assert.equal(buildChainAdjacency(MKT_NET(), { legalOnly: false, noOutpost: false }, idResolve).get(0)[0].fee, null);
  assert.equal(bestChain(ADJ, "A", 2, { cargo: 50 }).profit, 1_750); // fixture historique, sans `fee`
});
