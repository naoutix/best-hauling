// Batterie de tests des fonctions de calcul pures (app.js s'appuie dessus).
// Lancer : `node --test` (ou `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tripMinutes, loopMinutes, ageDays, pairAge, freshnessFactor, availabilityFactor,
  normalizeScores, bySort, computeUnits, effValue, fillCargo, addableUnits,
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
  assert.equal(computeUnits(100, 0, 120, f), 120);   // stock inconnu (0) ignoré
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
    { name: "A", buyPrice: 100, stock: 0, demand: 0, margin: 50 },
    { name: "B", buyPrice: 100, stock: 0, demand: 0, margin: 30 },
  ];
  const { lines, profit } = fillCargo(items, 60, Infinity);
  assert.equal(lines.length, 1);         // A remplit toute la soute
  assert.equal(lines[0].name, "A");
  assert.equal(lines[0].units, 60);
  assert.equal(profit, 60 * 50);
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

// ---------- addableUnits (suggestions) ----------
test("addableUnits : min(espace, stock, demande, budget/prix)", () => {
  const it = { buyPrice: 100, stock: 30, demand: 999 };
  assert.equal(addableUnits(it, { cargoLeft: 50, budgetLeft: Infinity }), 30);       // stock limite
  assert.equal(addableUnits(it, { cargoLeft: 10, budgetLeft: Infinity }), 10);       // soute limite
  assert.equal(addableUnits(it, { cargoLeft: 50, budgetLeft: 1500 }), 15);           // budget limite
  assert.equal(addableUnits(it, { cargoLeft: 0, budgetLeft: Infinity }), 0);         // plein
});
