#!/usr/bin/env node
// Récupère les données UEX et calcule les meilleures routes commerciales.
// Aucune dépendance : utilise fetch natif (Node >= 20). Exécuté par GitHub Actions.
//
// Source : UEX Corp API 2.0 (lecture publique, sans token) — https://uexcorp.space/api/documentation/
// Sortie : data/routes.json (routes classées) + data/meta.json (métadonnées).

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://api.uexcorp.uk/2.0";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// Nombre max de routes gardées dans le JSON (garde le fichier léger).
const MAX_ROUTES = 600;
// Nombre de terminaux de vente candidats par terminal d'achat.
const TOP_SELLS = 4;

async function getJSON(path) {
  const res = await fetch(`${API}/${path}`, {
    headers: { "User-Agent": "best-hauling/1.0 (github pages trade tool)" },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "ok") throw new Error(`${path} -> status ${body.status}`);
  return body.data;
}

function log(...a) {
  console.log("[build-data]", ...a);
}

// Normalise la catégorie d'une commodité (corrige casse et fautes de frappe UEX).
function normalizeKind(k) {
  k = (k || "").toLowerCase().trim();
  const fix = {
    minteral: "mineral",
    "man-made": "manmade",
    medicine: "medical",
    organics: "organic",
    "raw materials": "raw",
    "non-metal": "nonmetal",
  };
  return fix[k] || k || "other";
}

async function main() {
  log("Récupération des terminaux…");
  const terminals = await getJSON("terminals?type=commodity");
  log("Récupération de tous les prix…");
  const prices = await getJSON("commodities_prices_all");
  log("Récupération des vaisseaux…");
  const vehicles = await getJSON("vehicles");
  log("Récupération des commodités…");
  const commodities = await getJSON("commodities");
  const kindById = new Map(commodities.map((c) => [c.id, normalizeKind(c.kind)]));
  const illegalById = new Map(commodities.map((c) => [c.id, !!c.is_illegal]));

  // Index terminal id -> infos de localisation (uniquement terminaux disponibles).
  const term = new Map();
  for (const t of terminals) {
    if (!t.is_available) continue;
    term.set(t.id, {
      id: t.id,
      orbit: t.id_orbit || 0,
      name: t.nickname || t.name,
      code: t.code,
      system: t.star_system_name || "?",
      planet: t.planet_name || "",
      // Avant-poste de surface = élévateur de fret peu fiable. Stations/villes = fiables.
      outpost: t.id_outpost > 0,
    });
  }

  // Regroupe les prix par commodité.
  // Un "buy" = où acheter (price_buy > 0). Un "sell" = où vendre (price_sell > 0).
  const byCommodity = new Map();
  for (const p of prices) {
    const loc = term.get(p.id_terminal);
    if (!loc) continue; // terminal indisponible ou hors périmètre
    let c = byCommodity.get(p.id_commodity);
    if (!c) {
      c = {
        name: p.commodity_name,
        kind: kindById.get(p.id_commodity) || "other",
        illegal: illegalById.get(p.id_commodity) || false,
        buys: [],
        sells: [],
      };
      byCommodity.set(p.id_commodity, c);
    }
    if (p.price_buy > 0) {
      c.buys.push({ ...loc, price: p.price_buy, stock: p.scu_buy || 0 });
    }
    if (p.price_sell > 0) {
      c.sells.push({ ...loc, price: p.price_sell, demand: p.scu_sell_stock || 0 });
    }
  }

  // Génère les routes d'arbitrage.
  const routes = [];
  for (const [, c] of byCommodity) {
    if (!c.buys.length || !c.sells.length) continue;
    c.buys.sort((a, b) => a.price - b.price); // achat le moins cher d'abord
    c.sells.sort((a, b) => b.price - a.price); // vente la plus chère d'abord

    // On part du terminal d'achat le moins cher (le plus rentable en général).
    const buy = c.buys[0];
    const seen = new Set();
    const candidates = [];

    // Meilleures ventes globales.
    for (const s of c.sells.slice(0, TOP_SELLS)) candidates.push(s);
    // Meilleure vente dans le MÊME système (route sans saut inter-système).
    const sameSys = c.sells.find((s) => s.system === buy.system);
    if (sameSys) candidates.push(sameSys);

    for (const sell of candidates) {
      const key = `${buy.name}->${sell.name}`;
      if (seen.has(key)) continue;
      if (sell.name === buy.name) continue;
      const margin = sell.price - buy.price;
      if (margin <= 0) continue;
      seen.add(key);
      routes.push({
        commodity: c.name,
        kind: c.kind,
        illegal: c.illegal,
        buy: { terminal: buy.name, system: buy.system, planet: buy.planet, price: buy.price, stock: buy.stock, outpost: buy.outpost },
        sell: { terminal: sell.name, system: sell.system, planet: sell.planet, price: sell.price, demand: sell.demand, outpost: sell.outpost },
        margin,
        roi: Math.round((margin / buy.price) * 1000) / 10, // % ROI, 1 décimale
        same_system: buy.system === sell.system,
        // Ids/orbites temporaires pour le calcul de distance (retirés avant écriture).
        _o: buy.id, _d: sell.id, _oo: buy.orbit, _do: sell.orbit,
      });
    }
  }

  routes.sort((a, b) => b.margin - a.margin);
  const top = routes.slice(0, MAX_ROUTES);

  // Distance orbite→orbite via l'API UEX, mise en cache par paire d'orbites.
  const distCache = new Map();
  async function getDistance(oId, dId, oOrbit, dOrbit) {
    if (!oOrbit || !dOrbit || oOrbit === dOrbit) return 0; // même orbite = négligeable
    const key = `${oOrbit}-${dOrbit}`;
    if (distCache.has(key)) return distCache.get(key);
    let val = null;
    try {
      const d = await getJSON(`terminals_distances?id_terminal_origin=${oId}&id_terminal_destination=${dId}`);
      if (d && d.distance != null) val = Number(d.distance);
    } catch {
      val = null; // paires inter-systèmes parfois non renvoyées
    }
    distCache.set(key, val);
    return val;
  }

  log(`Calcul des distances (${top.length} routes)…`);
  for (const r of top) {
    r.distance = await getDistance(r._o, r._d, r._oo, r._do);
    delete r._o; delete r._d; delete r._oo; delete r._do;
  }

  // ---------- Boucles aller-retour (ne pas repartir à vide) ----------
  // Meilleure marge par paire de terminaux orientée (A -> B), toutes commodités confondues.
  const bestLeg = new Map();
  for (const [, c] of byCommodity) {
    for (const b of c.buys) {
      for (const s of c.sells) {
        if (b.id === s.id) continue;
        const margin = s.price - b.price;
        if (margin <= 0) continue;
        const key = `${b.id}->${s.id}`;
        const cur = bestLeg.get(key);
        if (!cur || margin > cur.margin) {
          bestLeg.set(key, {
            aId: b.id, bId: s.id,
            commodity: c.name, kind: c.kind, illegal: c.illegal,
            buyPrice: b.price, sellPrice: s.price, margin,
            stock: b.stock, demand: s.demand,
          });
        }
      }
    }
  }

  const legInfo = (leg) => ({
    commodity: leg.commodity, kind: leg.kind, illegal: leg.illegal,
    buyPrice: leg.buyPrice, sellPrice: leg.sellPrice, margin: leg.margin,
    stock: leg.stock, demand: leg.demand,
  });
  const termInfo = (id) => {
    const t = term.get(id);
    return { terminal: t.name, system: t.system, planet: t.planet, outpost: t.outpost };
  };

  const loops = [];
  const seenPair = new Set();
  for (const [key, out] of bestLeg) {
    const backKey = `${out.bId}->${out.aId}`;
    const back = bestLeg.get(backKey);
    if (!back) continue;
    const pairId = out.aId < out.bId ? `${out.aId}-${out.bId}` : `${out.bId}-${out.aId}`;
    if (seenPair.has(pairId)) continue;
    seenPair.add(pairId);
    loops.push({
      a: termInfo(out.aId),
      b: termInfo(out.bId),
      out: legInfo(out),
      back: legInfo(back),
      loopMargin: out.margin + back.margin,
      _a: out.aId, _b: out.bId, _ao: term.get(out.aId).orbit, _bo: term.get(out.bId).orbit,
    });
  }
  loops.sort((a, b) => b.loopMargin - a.loopMargin);
  const topLoops = loops.slice(0, 160);

  log(`Distances des boucles (${topLoops.length})…`);
  for (const l of topLoops) {
    const d1 = await getDistance(l._a, l._b, l._ao, l._bo);
    const d2 = await getDistance(l._b, l._a, l._bo, l._ao);
    l.distance = (d1 || 0) + (d2 || 0); // aller-retour
    delete l._a; delete l._b; delete l._ao; delete l._bo;
  }

  const systems = [...new Set(top.flatMap((r) => [r.buy.system, r.sell.system]))].sort();
  const meta = {
    generated_at: Math.floor(Date.now() / 1000),
    source: "UEX Corp API 2.0",
    source_url: "https://uexcorp.space",
    commodities: byCommodity.size,
    terminals: term.size,
    routes: top.length,
    loops: topLoops.length,
    systems,
  };

  // Vaisseaux avec soute (>= 1 SCU), hors véhicules terrestres. Pour le filtre "vaisseau".
  const ships = vehicles
    .filter((v) => v.scu >= 1 && !v.is_ground_vehicle)
    .map((v) => ({ name: v.name_full || v.name, scu: v.scu, photo: v.url_photo || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "routes.json"), JSON.stringify(top));
  await writeFile(join(OUT_DIR, "loops.json"), JSON.stringify(topLoops));
  await writeFile(join(OUT_DIR, "ships.json"), JSON.stringify(ships));
  await writeFile(join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2));
  log(`OK — ${top.length} routes, ${topLoops.length} boucles, ${byCommodity.size} commodités, ${term.size} terminaux, ${ships.length} vaisseaux.`);
}

main().catch((e) => {
  console.error("[build-data] ÉCHEC:", e.message);
  process.exit(1);
});
