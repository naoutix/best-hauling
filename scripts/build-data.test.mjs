// Tests des fonctions pures de génération de routes.
// Lancer : `node --test` (ou `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeKind, routesForCommodity, buildBestLegs, buildMarket, sellDemand, maxBoxSize, numField, shipEntry, SCU_RELEVES } from "./build-data.mjs";
import { readFileSync } from "node:fs";

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
    [10, { name: "A", system: "Stanton", planet: "Hurston", outpost: false, autoload: true, maxBox: 32 }],
    [20, { name: "B", system: "Pyro", planet: "", outpost: true, autoload: false, maxBox: 24 }],
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
  assert.deepEqual(m.terminals[0], { name: "A", system: "Stanton", planet: "Hurston", outpost: false, autoload: true, maxBox: 32 });
  const c = m.commodities[0];
  assert.deepEqual(c.buys[0], [0, 100, 50, 111, 4]);  // [idxTerminal, prix, stock, maj, statut]
  assert.deepEqual(c.sells[0], [1, 250, 80, 222, 2]); // [idxTerminal, prix, demande, maj, statut]
  assert.equal(m.terminals[c.sells[0][0]].system, "Pyro");
});

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

// ---------- Invariants de l'instantané data/market.json réellement produit ----------
// Les tests ci-dessus n'utilisent que des fixtures écrites à la main (1 à 3 commodités) : un défaut
// de FORME du fichier produit — tuple tronqué, index de terminal hors bornes, `undefined` là où
// logic.mjs attend `null` — leur est structurellement invisible. Ce test ouvre le fichier versionné
// et vérifie ce dont app.js et logic.mjs dépendent réellement.
// Il lit l'INSTANTANÉ commité, pas des données fraîches : `node --test` tourne avant
// `npm run build` dans update-data.yml, donc il ne peut pas bloquer un déploiement sur un aléa UEX.
const MARKET = JSON.parse(readFileSync(new URL("../data/market.json", import.meta.url), "utf8"));
const SHIPS = JSON.parse(readFileSync(new URL("../data/ships.json", import.meta.url), "utf8"));

// `autoload` / `maxBox` ne sont volontairement PAS vérifiés ici : `node --test` tourne AVANT
// `npm run build` (update-data.yml) et la CI ne re-commite jamais les data/*.json. L'instantané
// versionné ne portera donc les deux champs qu'après un build local recommité — les exiger ici
// rendrait la CI rouge sur une PR par ailleurs correcte. Présence et repli sont couverts sur
// fixture plus bas, là où ils sont de toute façon mieux testés (l'instantané du jour ne contient
// qu'un seul terminal muet sur la taille de caisse, et aucun plafonné à 1 SCU).
test("data/market.json : forme des terminaux", () => {
  assert.ok(MARKET.terminals.length > 0, "aucun terminal");
  for (const t of MARKET.terminals) {
    assert.equal(typeof t.name, "string");
    assert.ok(t.name.length, "terminal sans nom");
    assert.equal(typeof t.system, "string");
    assert.equal(typeof t.outpost, "boolean");
  }
});

test("data/market.json : chaque commodité est vendable et bien formée", () => {
  const n = MARKET.terminals.length;
  assert.ok(MARKET.commodities.length > 0, "aucune commodité");
  for (const c of MARKET.commodities) {
    // Le pipeline ne garde que le vendable : sans vente, la commodité n'a rien à dire.
    assert.ok(c.sells.length, `${c.name} : aucun point de vente`);
    assert.equal(typeof c.name, "string");
    assert.ok(c.name.length, "commodité sans nom");
    assert.equal(typeof c.code, "string");   // "" toléré, jamais undefined
    assert.equal(typeof c.illegal, "boolean");
    for (const [side, tuples, volNullable] of [["buys", c.buys, false], ["sells", c.sells, true]]) {
      for (const t of tuples) {
        assert.equal(t.length, 5, `${c.name}/${side} : tuple de ${t.length} champs au lieu de 5`);
        assert.ok(Number.isInteger(t[0]) && t[0] >= 0 && t[0] < n, `${c.name}/${side} : index terminal ${t[0]} hors bornes`);
        assert.ok(typeof t[1] === "number" && t[1] > 0, `${c.name}/${side} : prix ${t[1]} non strictement positif`);
        // Sémantique des volumes : côté vente, null = capacité non communiquée par UEX (aucun
        // plafond) et 0 = terminal saturé. Un `undefined` casserait ce distinguo silencieusement.
        if (volNullable) assert.ok(t[2] === null || typeof t[2] === "number", `${c.name}/sells : volume ${t[2]}`);
        else assert.equal(typeof t[2], "number", `${c.name}/buys : stock ${t[2]}`);
        assert.equal(typeof t[3], "number", `${c.name}/${side} : date ${t[3]}`);
        assert.equal(typeof t[4], "number", `${c.name}/${side} : statut ${t[4]}`);
      }
    }
  }
});

test("data/market.json : les commodités « vente seule » du mode Butin sont présentes", () => {
  // Régression de la PR #37 : le pipeline les excluait, le mode Butin n'avait rien à montrer.
  const sellOnly = MARKET.commodities.filter((c) => !c.buys.length);
  assert.ok(sellOnly.length > 0, "aucune commodité sans point d'achat : le mode Butin serait vide");
});

// ---------- Sémantique des volumes UEX à la source (le piège du projet) ----------
test("sellDemand : capacité RESTANTE, jamais le stock détenu", () => {
  assert.equal(sellDemand({}), null);                                    // UEX muet -> inconnu
  assert.equal(sellDemand({ scu_sell: 0 }), null);                       // idem : 0 = non renseigné
  assert.equal(sellDemand({ scu_sell: 100 }), 100);                      // rien détenu -> tout dispo
  assert.equal(sellDemand({ scu_sell: 100, scu_sell_stock: 30 }), 70);
  assert.equal(sellDemand({ scu_sell: 100, scu_sell_stock: 100 }), 0);   // saturé : 0 CONNU
  assert.equal(sellDemand({ scu_sell: 100, scu_sell_stock: 140 }), 0);   // jamais négatif
});

test("sellDemand : `null` (inconnu) et `0` (saturé) ne se confondent pas", () => {
  // Tout le comportement aval en dépend : null = aucun plafond de volume, 0 = plafonne à 0.
  assert.equal(sellDemand({ scu_sell: 0, scu_sell_stock: 50 }), null);
  assert.notEqual(sellDemand({}), 0);
  assert.equal(sellDemand({ scu_sell: 50, scu_sell_stock: 50 }), 0);
});

// ---------- Vaisseaux : les capacités relevées en jeu l'emportent sur UEX ----------
test("shipEntry : un vaisseau sans relevé garde la valeur UEX", () => {
  assert.deepEqual(shipEntry({ name_full: "Aegis Avenger Titan", scu: 8, url_photo: "u" }), { name: "Aegis Avenger Titan", scu: 8, photo: "u" });
  assert.equal(shipEntry({ name: "Sans photo", scu: 4 }).photo, ""); // photo absente -> chaîne vide
  assert.equal(shipEntry({ name: "Champ pourri", scu: "1e3; DROP" }).scu, 0); // coercition, comme partout
});

test("shipEntry : le relevé en jeu corrige UEX (Drake Ironclad)", () => {
  // UEX annonce 2 200 SCU ; le vaisseau en tient 2 216. Sans cette correction, la soute — donc les
  // unités, donc le profit et le classement de toutes les vues — est fausse à chaque rebuild.
  assert.equal(shipEntry({ name_full: "Drake Ironclad", scu: 2200 }).scu, 2216);
  assert.equal(shipEntry({ name_full: "Drake Ironclad Assault", scu: 1440 }).scu, 1440); // pas d'effet de bord sur le voisin
  assert.equal(SCU_RELEVES["Drake Ironclad"], 2216);
});

test("les relevés ne visent que des vaisseaux qui existent chez UEX", () => {
  // Un nom mal orthographié ne corrigerait rien et ne se verrait jamais : la table doit toujours
  // pointer sur un vaisseau réel de l'instantané versionné.
  const noms = new Set(SHIPS.map((s) => s.name));
  for (const n of Object.keys(SCU_RELEVES)) assert.ok(noms.has(n), `relevé orphelin : « ${n} » n'est pas un vaisseau UEX`);
});

test("data/ships.json : l'instantané versionné porte bien les relevés", () => {
  for (const [nom, scu] of Object.entries(SCU_RELEVES)) {
    assert.equal(SHIPS.find((s) => s.name === nom).scu, scu, `instantané pas régénéré pour ${nom}`);
  }
});

// ---------- Frais d'autoload : ce que le terminal impose à la manutention ----------
test("maxBoxSize : le 0 d'UEX (champ non renseigné) se replie sur 32", () => {
  assert.equal(maxBoxSize({ max_container_size: 0 }), 32);
  assert.equal(maxBoxSize({}), 32);                          // champ absent du relevé
  assert.equal(maxBoxSize({ max_container_size: null }), 32);
});

test("maxBoxSize : une vraie limite basse est conservée, jamais remontée à 32", () => {
  // Contre-épreuve du test précédent : sans elle, un `return 32` constant passerait au vert et le
  // repli n'aurait plus rien d'une règle. C'est aussi le cas qui coûte le plus cher au joueur —
  // un terminal plafonné à 1 SCU découpe 32 SCU en 32 caisses.
  assert.equal(maxBoxSize({ max_container_size: 1 }), 1);
  assert.equal(maxBoxSize({ max_container_size: 16 }), 16);
  assert.equal(maxBoxSize({ max_container_size: 24 }), 24);
  assert.equal(maxBoxSize({ max_container_size: 32 }), 32);
  assert.notEqual(maxBoxSize({ max_container_size: 1 }), maxBoxSize({ max_container_size: 0 }));
});

test("buildMarket publie autoload et maxBox par terminal", () => {
  const term = new Map([
    [10, { name: "Auto", system: "Pyro", planet: "", outpost: false, autoload: true, maxBox: 16 }],
    // Pas d'autoload, mais un plafond de caisse tout de même : c'est encore lui qui décide du
    // découpage quand le joueur empile à la main.
    [20, { name: "Manuel", system: "Stanton", planet: "", outpost: false, autoload: false, maxBox: 32 }],
  ]);
  const byCommodity = new Map([
    [1, {
      name: "Laranite", kind: "metal", illegal: false,
      buys: [buy({ id: 10, price: 100, stock: 50 })],
      sells: [buy({ id: 20, price: 250, demand: 80 })],
    }],
  ]);
  const m = buildMarket(byCommodity, term);
  assert.equal(m.terminals[0].autoload, true);
  assert.equal(m.terminals[0].maxBox, 16);
  assert.equal(m.terminals[1].autoload, false);
  assert.equal(m.terminals[1].maxBox, 32);
});

test("numField : un champ UEX non numérique ne traverse jamais le pipeline", () => {
  // UEX est une source tierce. Le `|| 0` d'origine ne rejetait que les valeurs fausses : toute
  // CHAÎNE non vide passait telle quelle, traversait data/market.json et finissait interpolée dans
  // un attribut HTML par editv(). C'est le chemin d'entrée d'une charge XSS.
  assert.equal(numField(42), 42);
  assert.equal(numField("42"), 42);      // UEX renvoie parfois ses nombres en chaîne
  assert.equal(numField(0), 0);
  assert.equal(numField(null), 0);
  assert.equal(numField(undefined), 0);
  assert.equal(numField(""), 0);
  assert.equal(numField('0" autofocus onfocus="fetch(evil)'), 0);
  assert.equal(numField("NaN"), 0);
  assert.equal(numField(Infinity), 0);   // non fini = inexploitable en volume comme en date
  assert.equal(numField(-5), -5);        // on coerce, on ne juge pas du signe
});

test("sellDemand : une capacité UEX non numérique ne devient pas un plafond fantaisiste", () => {
  assert.equal(sellDemand({ scu_sell: "toto", scu_sell_stock: 0 }), null); // illisible = inconnu
  assert.equal(sellDemand({ scu_sell: "100", scu_sell_stock: "40" }), 60); // chaînes numériques OK
});
