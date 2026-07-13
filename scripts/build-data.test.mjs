// Tests des fonctions pures de génération de routes.
// Lancer : `node --test` (ou `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeKind, routesForCommodity, buildBestLegs, buildMarket } from "./build-data.mjs";

test("normalizeKind corrige la casse, les fautes de frappe et les valeurs vides", () => {
  assert.equal(normalizeKind("Minteral"), "mineral");
  assert.equal(normalizeKind("Man-Made"), "manmade");
  assert.equal(normalizeKind("  Medicine "), "medical");
  assert.equal(normalizeKind("Raw Materials"), "raw");
  assert.equal(normalizeKind("Metal"), "metal"); // déjà correct
  assert.equal(normalizeKind(""), "other"); // vide -> other
  assert.equal(normalizeKind(null), "other"); // null -> other
});

// Fabrique un buy/sell de test avec des valeurs par défaut raisonnables.
const buy = (o) => ({ id: 0, orbit: 0, name: "?", system: "Stanton", planet: "", price: 0, stock: 0, updated: 0, status: 0, outpost: false, ...o });

test("routesForCommodity ne retient que les marges positives", () => {
  const c = {
    name: "Laranite", kind: "metal", illegal: false, refBuy: 100, refSell: 200,
    buys: [buy({ id: 1, name: "A", price: 100 })],
    sells: [
      buy({ id: 2, name: "B", system: "Pyro", price: 250 }), // marge +150
      buy({ id: 3, name: "C", price: 80 }),                   // marge -20 -> exclue
    ],
  };
  const routes = routesForCommodity(c);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].sell.terminal, "B");
  assert.equal(routes[0].margin, 150);
  assert.equal(routes[0].roi, 150); // (150/100)*100
  assert.equal(routes[0].same_system, false); // Stanton -> Pyro
});

test("routesForCommodity part du terminal d'achat le moins cher", () => {
  const c = {
    name: "Gold", kind: "metal", illegal: false, refBuy: 0, refSell: 0,
    buys: [buy({ id: 1, name: "Cher", price: 500 }), buy({ id: 2, name: "PasCher", price: 300 })],
    sells: [buy({ id: 3, name: "Vente", price: 900 })],
  };
  const routes = routesForCommodity(c);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].buy.terminal, "PasCher");
  assert.equal(routes[0].margin, 600);
});

test("routesForCommodity ignore les commodités sans achat ou sans vente", () => {
  assert.deepEqual(routesForCommodity({ name: "X", buys: [], sells: [buy({ id: 1 })] }), []);
  assert.deepEqual(routesForCommodity({ name: "X", buys: [buy({ id: 1 })], sells: [] }), []);
});

test("routesForCommodity ne crée pas de route terminal -> lui-même", () => {
  const c = {
    name: "Y", kind: "metal", illegal: false, refBuy: 0, refSell: 0,
    buys: [buy({ id: 1, name: "Meme", price: 100 })],
    sells: [buy({ id: 1, name: "Meme", price: 300 })], // même nom -> exclu
  };
  assert.deepEqual(routesForCommodity(c), []);
});

test("buildBestLegs garde la meilleure marge par paire orientée", () => {
  const byCommodity = new Map([
    [1, {
      name: "C1", kind: "metal", illegal: false,
      buys: [buy({ id: 10, name: "A", price: 100 })],
      sells: [buy({ id: 20, name: "B", price: 150 })], // A->B marge 50
    }],
    [2, {
      name: "C2", kind: "gas", illegal: false,
      buys: [buy({ id: 10, name: "A", price: 100 })],
      sells: [buy({ id: 20, name: "B", price: 300 })], // A->B marge 200 (meilleure)
    }],
  ]);
  const legs = buildBestLegs(byCommodity);
  const leg = legs.get("10->20");
  assert.ok(leg);
  assert.equal(leg.margin, 200);
  assert.equal(leg.commodity, "C2");
});

test("buildBestLegs ignore les marges nulles ou négatives et les mêmes terminaux", () => {
  const byCommodity = new Map([
    [1, {
      name: "C", kind: "metal", illegal: false,
      buys: [buy({ id: 10, price: 200 }), buy({ id: 20, price: 100 })],
      sells: [buy({ id: 10, price: 100 }), buy({ id: 20, price: 150 })],
    }],
  ]);
  const legs = buildBestLegs(byCommodity);
  // 20->10 : marge 100-100=0 exclue ; 20->20 même id exclu ; 10->10 même id exclu.
  // Seule 20(achat 100)->10(vente 100)=0 et 10(200)->20(150)=-50 : rien de positif.
  assert.equal(legs.size, 0);
});

test("buildMarket déduplique les terminaux et compacte achats/ventes en tuples", () => {
  const term = new Map([
    [10, { name: "A", system: "Stanton", planet: "Hurston", outpost: false }],
    [20, { name: "B", system: "Pyro", planet: "", outpost: true }],
  ]);
  const byCommodity = new Map([
    [1, {
      name: "Laranite", kind: "metal", illegal: false,
      buys: [buy({ id: 10, price: 100, stock: 50, updated: 111, status: 4 })],
      sells: [buy({ id: 20, price: 250, demand: 80, updated: 222, status: 2 })],
    }],
    // Commodité sans vente -> exclue du marché.
    [2, { name: "X", kind: "gas", illegal: false, buys: [buy({ id: 10, price: 10 })], sells: [] }],
  ]);
  const m = buildMarket(byCommodity, term);
  assert.equal(m.commodities.length, 1); // la commodité sans vente est écartée
  assert.deepEqual(m.terminals[0], { name: "A", system: "Stanton", planet: "Hurston", outpost: false });
  const c = m.commodities[0];
  assert.deepEqual(c.buys[0], [0, 100, 50, 111, 4]);  // [idxTerminal, prix, stock, maj, statut]
  assert.deepEqual(c.sells[0], [1, 250, 80, 222, 2]); // [idxTerminal, prix, demande, maj, statut]
  assert.equal(m.terminals[c.sells[0][0]].system, "Pyro");
});
