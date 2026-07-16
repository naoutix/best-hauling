// Fonctions de calcul PURES (sans DOM ni état) — utilisées par app.js (navigateur) et
// couvertes par logic.test.mjs (node --test). Aucune dépendance.

// ---------- Temps de trajet estimé ----------
// Constantes approximatives — servent surtout à classer les routes entre elles.
export const HANDLING = 3, PER_DIST = 0.06, JUMP = 4;
export function tripMinutes(distance, cross) {
  return 2 * HANDLING + (distance || 0) * PER_DIST + (cross ? JUMP : 0);
}
export function loopMinutes(distance, cross) {
  return 4 * HANDLING + (distance || 0) * PER_DIST + (cross ? 2 * JUMP : 0);
}

// ---------- Fraîcheur ----------
// Âge d'un relevé en jours (null si date inconnue). nowSec injectable pour les tests.
export function ageDays(updated, nowSec = Date.now() / 1000) {
  if (!updated) return null;
  return (nowSec - updated) / 86400;
}
// Âge d'une route/boucle = le relevé le plus ancien des deux extrémités.
export function pairAge(a, b, nowSec = Date.now() / 1000) {
  const u = a && b ? Math.min(a, b) : a || b || 0;
  return ageDays(u, nowSec);
}
// Facteur de fraîcheur : 1.0 tout frais -> 0.2 au-delà de ~11 j ; 0.5 si date inconnue.
export function freshnessFactor(age) {
  if (age == null) return 0.5;
  return Math.max(0.2, 1 - age / 14);
}
// Facteur de disponibilité (saturation sur min(stock, demande)).
export function availabilityFactor(stock, demand) {
  if (!stock && !demand) return 0.65;
  const m = Math.min(stock || 0, demand || 0);
  return 0.3 + 0.7 * (m / (m + 120));
}

// ---------- Profit horaire & score brut (partagés routes/boucles) ----------
// Profit par heure d'un trajet (null si le profit n'est pas borné = pas de contrainte de volume).
export function profitPerHour(profit, minutes) {
  return profit == null ? null : (profit * 60) / minutes;
}
// Score brut = valeur × fiabilité. Valeur = profit/heure si la route est bornée
// (profitHour connu), sinon la marge brute (fallbackMargin). Fiabilité = fraîcheur × disponibilité.
export function rawScoreOf(profitHour, fallbackMargin, age, stock, demand) {
  const base = profitHour == null ? fallbackMargin : profitHour;
  return base * freshnessFactor(age) * availabilityFactor(stock, demand);
}

// ---------- Score ----------
// Normalise les scores bruts d'une liste sur 0-100 (100 = meilleur de la liste).
export function normalizeScores(rows) {
  const max = rows.reduce((m, r) => Math.max(m, r.rawScore || 0), 0);
  rows.forEach((r) => (r.score = max > 0 ? Math.round((r.rawScore / max) * 100) : 0));
  return rows;
}

// ---------- Tri (valeurs nulles en bas ; chaînes sensibles à la locale) ----------
export function bySort(key, dir) {
  return (a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv, "fr") * dir;
    return av > bv ? dir : av < bv ? -dir : 0;
  };
}

// ---------- Filtrage partagé (routes simples, « En route », boucles) ----------
// f = { sameOnly, noOutpost, legalOnly, sysFilter, maxAge, q }. sysFilter vide = pas de filtre système.
// La vue « En route » passe sysFilter:"" (le système d'achat est déjà fixé par le terminal de départ).
export function routePasses(r, f) {
  if (f.sameOnly && !r.same_system) return false;
  if (f.noOutpost && (r.buy.outpost || r.sell.outpost)) return false;
  if (f.legalOnly && r.illegal) return false;
  if (f.sysFilter && r.buy.system !== f.sysFilter) return false;
  if (f.maxAge) {
    const a = pairAge(r.buy.updated, r.sell.updated);
    if (a == null || a > f.maxAge) return false;
  }
  if (f.q && !r.commodity.toLowerCase().includes(f.q)) return false;
  return true;
}
// Boucle A⇄B : le filtre système garde la boucle si A OU B correspond ; recherche sur les deux commodités.
export function loopPasses(l, f) {
  if (f.sameOnly && l.a.system !== l.b.system) return false;
  if (f.noOutpost && (l.a.outpost || l.b.outpost)) return false;
  if (f.legalOnly && (l.out.illegal || l.back.illegal)) return false;
  if (f.sysFilter && l.a.system !== f.sysFilter && l.b.system !== f.sysFilter) return false;
  if (f.maxAge) {
    const a = pairAge(l.out.updated, l.back.updated);
    if (a == null || a > f.maxAge) return false;
  }
  if (f.q && !(l.out.commodity.toLowerCase().includes(f.q) || l.back.commodity.toLowerCase().includes(f.q))) return false;
  return true;
}

// ---------- Unités achetables selon les contraintes actives ----------
// f = { cargo, budget, capStock, useCargo, useBudget }. Infinity si aucune contrainte de volume.
// demandKnown = true si la demande est fiable (corrigée par l'utilisateur) -> un 0 plafonne à 0.
export function computeUnits(price, stock, demand, f, demandKnown = false) {
  const byCargo = f.useCargo ? f.cargo : Infinity;
  const byBudget = f.useBudget && f.budget > 0 ? Math.floor(f.budget / price) : Infinity;
  let units = Math.min(byCargo, byBudget);
  if (f.capStock) {
    // Stock à l'achat : 0 = terminal vide (dans les données UEX, stock 0 => statut « Vide ») -> plafonne à 0.
    units = Math.min(units, stock);
    // Demande à la vente : 0 brut = quantité non renseignée (ignorée) ; 0 corrigé = « pas de demande » (plafonne).
    if (demand > 0 || demandKnown) units = Math.min(units, demand);
  }
  if (isFinite(units) && units < 0) units = 0;
  return units;
}

// ---------- Champs dérivés d'un trajet (unités, profit, temps, score) ----------
// Cœur de calcul PUR d'une route dont les prix/volumes sont déjà résolus (corrections appliquées
// en amont). m = { buyPrice, buyStock, sellDemand, margin, distance, sameSystem, buyUpdated,
// sellUpdated, demandKnown }. Renvoie units/investment (null si non bornés) + profit/minutes/
// profitHour/rawScore. `evaluate` (app.js) applique d'abord les corrections puis délègue ici.
export function routeMetrics(m, f) {
  const units = computeUnits(m.buyPrice, m.buyStock, m.sellDemand, f, m.demandKnown);
  const bounded = isFinite(units);
  const profit = bounded ? units * m.margin : null;
  const minutes = tripMinutes(m.distance, !m.sameSystem);
  const profitHour = profitPerHour(profit, minutes);
  const rawScore = rawScoreOf(profitHour, m.margin, pairAge(m.buyUpdated, m.sellUpdated), m.buyStock, m.sellDemand);
  return {
    units: bounded ? units : null,
    investment: bounded ? units * m.buyPrice : null,
    profit, minutes, profitHour, rawScore,
  };
}

// Idem pour une boucle A⇄B (deux segments). out/back = { buyPrice, stock, demand, margin,
// updated, demandKnown }. La boucle n'est bornée que si SES DEUX segments le sont.
export function loopMetrics(out, back, distance, cross, f) {
  const loopMargin = out.margin + back.margin;
  const uOut = computeUnits(out.buyPrice, out.stock, out.demand, f, out.demandKnown);
  const uBack = computeUnits(back.buyPrice, back.stock, back.demand, f, back.demandKnown);
  const bounded = isFinite(uOut) && isFinite(uBack);
  const minutes = loopMinutes(distance, cross);
  const profit = bounded ? uOut * out.margin + uBack * back.margin : null;
  const profitHour = profitPerHour(profit, minutes);
  const rawScore = rawScoreOf(
    profitHour, loopMargin, pairAge(out.updated, back.updated),
    Math.min(out.stock, back.stock), Math.min(out.demand, back.demand)
  );
  return {
    loopMargin,
    unitsOut: bounded ? uOut : null,
    unitsBack: bounded ? uBack : null,
    units: bounded ? uOut + uBack : null,
    investment: bounded ? Math.max(uOut * out.buyPrice, uBack * back.buyPrice) : null,
    profit, minutes, profitHour, rawScore,
  };
}

// ---------- Corrections locales : décision de fraîcheur (pure, sans effet de bord) ----------
// o = correction { price?, vol?, base } (base = date UEX du point au moment de la correction).
// Renvoie prix/volume effectifs + drapeaux + `stale` (true = périmée par un relevé plus récent).
export function effValue(o, price, vol, dataUpdated) {
  if (!o) return { price, vol, oprice: false, ovol: false, stale: false };
  const base = o.base != null ? o.base : o.ts != null ? o.ts : Infinity; // legacy: ts ; sinon jamais périmé
  if (dataUpdated && base !== Infinity && dataUpdated > base) {
    return { price, vol, oprice: false, ovol: false, stale: true };
  }
  return {
    price: o.price != null ? o.price : price,
    vol: o.vol != null ? o.vol : vol,
    oprice: o.price != null,
    ovol: o.vol != null,
    stale: false,
  };
}

// ---------- Manifeste : remplissage glouton ----------
// `items` déjà triés par marge décroissante. Plafonné par stock/demande ET budget.
export function fillCargo(items, cargo, budget) {
  let cargoLeft = cargo;
  let budgetLeft = budget;
  const lines = [];
  let profit = 0;
  for (const it of items) {
    if (cargoLeft <= 0 || budgetLeft <= 0) break;
    let u = cargoLeft;
    u = Math.min(u, it.stock);                          // stock 0 = vide -> ligne exclue (u <= 0)
    if (it.demand > 0 || it.demandKnown) u = Math.min(u, it.demand); // 0 corrigé = pas de demande
    if (isFinite(budgetLeft)) u = Math.min(u, Math.floor(budgetLeft / it.buyPrice));
    if (u <= 0) continue;
    lines.push({ ...it, units: u, cap: u });
    cargoLeft -= u;
    budgetLeft -= u * it.buyPrice;
    profit += u * it.margin;
  }
  return { lines, profit };
}

// ---------- Décomposition en caisses SCU standard ----------
// Répartit N SCU en conteneurs standard (plus grand d'abord). Renvoie [{size, count}, ...].
export const SCU_BOX_SIZES = [32, 24, 16, 8, 4, 2, 1];
export function scuBoxes(n) {
  n = Math.max(0, Math.floor(n || 0));
  const out = [];
  for (const size of SCU_BOX_SIZES) {
    const count = Math.floor(n / size);
    if (count > 0) { out.push({ size, count }); n -= count * size; }
  }
  return out;
}

// ---------- Chaîne multi-sauts (A -> B -> C ...) ----------
// Meilleure chaîne de `hops` sauts depuis `start`, sans revisiter un terminal.
// adj : Map<terminal, leg[]> ; leg = { to, margin, stock, demand, buyPrice, ... }.
// Recherche par faisceau (beam) : approximation robuste et bornée en temps. Chaque saut
// remplit la soute (`cargo`), plafonnée par stock/demande ; le budget se reconstitue à la
// vente donc n'est pas une contrainte de chaîne. Renvoie { path, legs, profit } ou null.
export function bestChain(adj, start, hops, { cargo = Infinity, beam = 40 } = {}) {
  const legUnits = (leg) => {
    let u = cargo;
    u = Math.min(u, leg.stock);                     // stock 0 = terminal vide -> saut exclu
    if (leg.demand > 0 || leg.demandKnown) u = Math.min(u, leg.demand); // 0 corrigé = pas de demande
    return isFinite(u) ? Math.max(0, u) : 0; // sans borne de volume : rien (chaîne = soute finie)
  };
  let paths = [{ path: [start], visited: new Set([start]), profit: 0, legs: [] }];
  let best = null;
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const p of paths) {
      const u = p.path[p.path.length - 1];
      for (const leg of adj.get(u) || []) {
        if (leg.margin <= 0 || p.visited.has(leg.to)) continue;
        const units = legUnits(leg);
        if (units <= 0) continue;
        const legProfit = units * leg.margin;
        const visited = new Set(p.visited);
        visited.add(leg.to);
        next.push({
          path: [...p.path, leg.to],
          visited,
          profit: p.profit + legProfit,
          legs: [...p.legs, { ...leg, units, profit: legProfit }],
        });
      }
    }
    if (!next.length) break;
    next.sort((a, b) => b.profit - a.profit);
    paths = next.slice(0, beam);
    if (!best || paths[0].profit > best.profit) best = paths[0]; // chaque saut ajoute un profit positif
  }
  return best ? { path: best.path, legs: best.legs, profit: best.profit } : null;
}

// ---------- Unités ajoutables d'une commodité candidate (suggestions) ----------
export function addableUnits(it, rem) {
  let u = rem.cargoLeft;
  u = Math.min(u, it.stock);                          // stock 0 = vide -> non suggéré
  if (it.demand > 0 || it.demandKnown) u = Math.min(u, it.demand); // 0 corrigé = pas de demande
  if (isFinite(rem.budgetLeft)) u = Math.min(u, Math.floor(rem.budgetLeft / it.buyPrice));
  return Math.max(0, u);
}

// ---------- Corrections locales : opérations sur un store injectable ----------
// Le store est un objet { "commodité|terminal|side": { price?, vol?, base } }.
export const ovKey = (commodity, terminal, side) => `${commodity}|${terminal}|${side}`;

// Valeur effective (corrigée si besoin) + suppression de la correction périmée du store.
// Renvoie { price, vol, oprice, ovol, stale }. Seul effet de bord : delete store[key] si périmé.
export function effFromStore(store, key, price, vol, dataUpdated) {
  const r = effValue(store[key], price, vol, dataUpdated);
  if (r.stale) delete store[key];
  return r;
}

// Enregistre/efface une correction. field = "price"|"vol". value null/"" efface ce champ.
// baseUpdated = date UEX du point (ancre de fraîcheur). Supprime la clé si plus rien de corrigé.
export function setInStore(store, key, field, value, baseUpdated) {
  const o = store[key] || {};
  const n = value == null || value === "" ? NaN : Math.max(0, Math.round(Number(value)));
  if (Number.isFinite(n)) o[field] = n;
  else delete o[field];
  if (o.price != null || o.vol != null) { o.base = Number(baseUpdated) || 0; store[key] = o; }
  else delete store[key];
  return store;
}

// ---------- État partageable (URL / localStorage) ----------
export const safeKey = (k) => typeof k === "string" && /^[a-zA-Z]+$/.test(k); // anti-injection de sélecteur

// Encode un objet d'état en query-string (ignore les valeurs vides/nulles).
export function encodeState(obj) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== "" && v != null) p.set(k, v); });
  return p.toString();
}
// Décode une query-string en objet (null si vide).
export function decodeState(str) {
  return str ? Object.fromEntries(new URLSearchParams(str)) : null;
}

// ---------- Marché interactif : recherche de trajets (En route, manifeste, chaîne) ----------
// `market` = { terminals:[{name,system,planet,outpost}], commodities:[{name,kind,illegal,buys,sells}] }
// où chaque buy/sell est un tuple compact [idxTerminal, prix, volume, updated, statut].
// `resolve(commodity, terminalName, side, price, vol, updated)` applique les corrections locales et
// renvoie au moins { price, vol, ovol } (identité si aucune correction). PURES si `resolve` l'est.

// Construit un objet « route » (compatible evaluate/routeRowHTML) depuis un achat + une vente bruts.
export function dealFrom(market, c, b, s) {
  const bt = market.terminals[b[0]], st = market.terminals[s[0]];
  const margin = s[1] - b[1];
  return {
    commodity: c.name, kind: c.kind, illegal: c.illegal,
    buy: { terminal: bt.name, system: bt.system, planet: bt.planet, outpost: bt.outpost, price: b[1], stock: b[2], updated: b[3], status: b[4] },
    sell: { terminal: st.name, system: st.system, planet: st.planet, outpost: st.outpost, price: s[1], demand: s[2], updated: s[3], status: s[4] },
    margin, roi: Math.round((margin / b[1]) * 1000) / 10,
    same_system: bt.system === st.system,
    distance: 0,       // distance exacte indisponible hors routes.json -> estimation grossière
    refBuy: 0, refSell: 0,
  };
}

// Meilleure vente par commodité depuis le terminal `origin`. `destTerminal` (index) force un
// terminal d'arrivée précis ; sinon `destSystem` filtre par système ("" = n'importe où).
// Données brutes (les corrections sont appliquées ensuite par evaluate) -> pas de `resolve`.
export function enRouteDeals(market, origin, destSystem, destTerminal = null) {
  const deals = [];
  market.commodities.forEach((c) => {
    const b = c.buys.find((x) => x[0] === origin);
    if (!b) return;
    let best = null;
    for (const s of c.sells) {
      if (s[0] === origin) continue;
      if (destTerminal != null) { if (s[0] !== destTerminal) continue; }
      else if (destSystem && market.terminals[s[0]].system !== destSystem) continue;
      if (!best || s[1] > best[1]) best = s;
    }
    if (best && best[1] > b[1]) deals.push(dealFrom(market, c, b, best));
  });
  return deals;
}

// Manifeste : destination (terminal) qui maximise le profit d'un chargement multi-commodité depuis
// `origin`, soute remplie par marge décroissante (fillCargo). Toujours plafonné par stock/demande
// (ce qui force à diversifier). Null si la soute n'est pas contrainte.
// `destTerminal` (index) force un terminal d'arrivée précis ; sinon `destSystem` filtre par système.
export function bestManifest(market, origin, destSystem, f, resolve, destTerminal = null) {
  if (!f.useCargo || !(f.cargo > 0)) return null;
  const ot = market.terminals[origin];
  const byDest = new Map();
  market.commodities.forEach((c) => {
    if (f.legalOnly && c.illegal) return;
    const b = c.buys.find((x) => x[0] === origin);
    if (!b) return;
    const eb = resolve(c.name, ot.name, "buy", b[1], b[2], b[3]); // prix/stock corrigés
    c.sells.forEach((s) => {
      if (s[0] === origin) return;
      const st = market.terminals[s[0]];
      if (destTerminal != null) { if (s[0] !== destTerminal) return; }
      else if (destSystem && st.system !== destSystem) return;
      if (f.noOutpost && st.outpost) return;
      const es = resolve(c.name, st.name, "sell", s[1], s[2], s[3]);
      const margin = es.price - eb.price;
      if (margin <= 0) return;
      if (!byDest.has(s[0])) byDest.set(s[0], []);
      byDest.get(s[0]).push({ name: c.name, kind: c.kind, illegal: c.illegal, buyPrice: eb.price, stock: eb.vol, sellPrice: es.price, demand: es.vol, demandKnown: es.ovol, margin, buyUpdated: b[3], sellUpdated: s[3] });
    });
  });

  const budget = f.useBudget && f.budget > 0 ? f.budget : Infinity;
  let best = null;
  for (const [dest, items] of byDest) {
    items.sort((a, b) => b.margin - a.margin);
    const { lines, profit } = fillCargo(items, f.cargo, budget);
    if (lines.length && (!best || profit > best.profit)) {
      const dt = market.terminals[dest];
      best = { origin: ot, dest: dt, destIdx: dest, cross: ot.system !== dt.system, lines, profit, cargo: f.cargo };
    }
  }
  return best;
}

// Graphe des meilleurs segments : pour chaque paire (départ -> arrivée), la commodité de marge
// maximale (corrections comprises). Renvoie Map<idxTerminal, leg[]> pour bestChain.
export function buildChainAdjacency(market, f, resolve) {
  const best = new Map(); // Map<u, Map<v, leg>>
  market.commodities.forEach((c) => {
    if (f.legalOnly && c.illegal) return;
    c.buys.forEach((b) => {
      const bt = market.terminals[b[0]];
      if (f.noOutpost && bt.outpost) return;
      const eb = resolve(c.name, bt.name, "buy", b[1], b[2], b[3]);
      c.sells.forEach((s) => {
        if (s[0] === b[0]) return;
        const st = market.terminals[s[0]];
        if (f.noOutpost && st.outpost) return;
        if (f.sameOnly && bt.system !== st.system) return;          // même système uniquement
        if (f.maxAge) { const a = pairAge(b[3], s[3]); if (a == null || a > f.maxAge) return; } // fraîcheur
        const es = resolve(c.name, st.name, "sell", s[1], s[2], s[3]);
        const margin = es.price - eb.price;
        if (margin <= 0) return;
        let m = best.get(b[0]);
        if (!m) { m = new Map(); best.set(b[0], m); }
        const cur = m.get(s[0]);
        if (!cur || margin > cur.margin) {
          m.set(s[0], { to: s[0], commodity: c.name, kind: c.kind, illegal: c.illegal, margin, buyPrice: eb.price, sellPrice: es.price, stock: eb.vol, demand: es.vol, demandKnown: es.ovol });
        }
      });
    });
  });
  const adj = new Map();
  for (const [u, m] of best) adj.set(u, [...m.values()]);
  return adj;
}

// ---------- Panneau « Commodités » : résumé global + points d'achat/vente ----------
// Une ligne de synthèse par commodité (pour le grand tableau triable).
// f (optionnel) = { legalOnly, noOutpost } — seuls filtres pertinents ici : masque les
// commodités illégales, et exclut les points en avant-poste du calcul best/compteurs.
export function commoditySummaries(market, f = {}) {
  const out = [];
  for (const c of market.commodities) {
    if (f.legalOnly && c.illegal) continue;
    const buys = f.noOutpost ? c.buys.filter((b) => !market.terminals[b[0]].outpost) : c.buys;
    const sells = f.noOutpost ? c.sells.filter((s) => !market.terminals[s[0]].outpost) : c.sells;
    // Achat le moins cher / vente la plus chère + le statut d'inventaire à ce point.
    let bestBuy = null, buyStatus = 0;
    for (const b of buys) if (bestBuy == null || b[1] < bestBuy) { bestBuy = b[1]; buyStatus = b[4] || 0; }
    let bestSell = null, sellStatus = 0;
    for (const s of sells) if (bestSell == null || s[1] > bestSell) { bestSell = s[1]; sellStatus = s[4] || 0; }
    const margin = bestBuy != null && bestSell != null ? bestSell - bestBuy : null;
    out.push({
      name: c.name, code: c.code || "", kind: c.kind, illegal: c.illegal,
      nBuy: buys.length, nSell: sells.length, bestBuy, bestSell, buyStatus, sellStatus, margin,
    });
  }
  return out;
}

// Tous les points d'ACHAT (les moins chers d'abord) et de VENTE (les plus chers d'abord)
// d'une commodité, avec la localisation du terminal. Null si commodité inconnue.
export function commodityPoints(market, name, f = {}) {
  const c = market.commodities.find((x) => x.name === name);
  if (!c) return null;
  const T = (i) => market.terminals[i];
  const keep = (p) => !(f.noOutpost && T(p[0]).outpost); // exclut les avant-postes si demandé
  const point = (p, volKey) => ({
    terminal: T(p[0]).name, system: T(p[0]).system, planet: T(p[0]).planet, outpost: T(p[0]).outpost,
    price: p[1], [volKey]: p[2], updated: p[3], status: p[4],
  });
  const buys = c.buys.filter(keep).map((b) => point(b, "stock")).sort((a, b) => a.price - b.price);
  const sells = c.sells.filter(keep).map((s) => point(s, "demand")).sort((a, b) => b.price - a.price);
  return { name: c.name, code: c.code || "", kind: c.kind, illegal: c.illegal, buys, sells };
}

// Notation compacte K/M pour les tuiles du board (ex. 9600 -> "9.6K", 1_600_000 -> "1.6M").
export function compactValue(n) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return Math.round(n / 1e5) / 10 + "M";
  if (a >= 1e3) return Math.round(n / 100) / 10 + "K";
  return String(Math.round(n));
}

// ---------- Compagnon de voyage : modèle de « parcours » (pur, sérialisable) ----------
// Un parcours = suite ORDONNÉE de sauts (legs) contigus + position courante (index de station).
//   leg = { from, fromSystem, to, toSystem, commodity, buyPrice, sellPrice, margin }
//   stations dérivées = [from0, to0(=from1), to1, …]  ->  legs.length + 1 stations.
//   current = index de la station où l'on se trouve (0..legs.length). La « jambe courante »
//   va de stations[current] à stations[current+1].

// Construit une jambe depuis un trajet évalué (vue Trajets / En route).
export function legFromRoute(r) {
  return {
    from: r.buy.terminal, fromSystem: r.buy.system, to: r.sell.terminal, toSystem: r.sell.system,
    commodity: r.commodity, buyPrice: r.buy.price, sellPrice: r.sell.price, margin: r.margin,
  };
}
// Deux jambes depuis une boucle évaluée (aller puis retour).
// `startAt` = terminal par lequel entrer dans le cycle : une boucle A⇄B se parcourt aussi bien
// B->A->B que A->B->A. Sans lui, on partirait toujours de `a`, et une boucle raccordée au parcours
// par son `b` ne s'enchaînerait pas -> addToJourney REMPLACERAIT le voyage au lieu de l'étendre.
export function legsFromLoop(l, startAt) {
  const out = { from: l.a.terminal, fromSystem: l.a.system, to: l.b.terminal, toSystem: l.b.system, commodity: l.out.commodity, buyPrice: l.out.buyPrice, sellPrice: l.out.sellPrice, margin: l.out.margin };
  const back = { from: l.b.terminal, fromSystem: l.b.system, to: l.a.terminal, toSystem: l.a.system, commodity: l.back.commodity, buyPrice: l.back.buyPrice, sellPrice: l.back.sellPrice, margin: l.back.margin };
  return startAt === l.b.terminal && startAt !== l.a.terminal ? [back, out] : [out, back];
}
// N jambes depuis une chaîne (bestChain) : `terminals` résout les index -> noms/systèmes.
export function legsFromChain(chain, terminals) {
  return chain.legs.map((leg, i) => {
    const from = terminals[chain.path[i]], to = terminals[chain.path[i + 1]];
    return { from: from.name, fromSystem: from.system, to: to.name, toSystem: to.system, commodity: leg.commodity, buyPrice: leg.buyPrice, sellPrice: leg.sellPrice, margin: leg.margin };
  });
}

// Démarre un parcours neuf à partir de jambes (position au départ).
export function startJourney(legs) {
  return { legs: legs.slice(), current: 0 };
}
// Démarre un parcours « de zéro » : juste un point de départ, sans jambe encore.
// On construit ensuite le parcours en ajoutant des arrêts (addToJourney).
export function startJourneyAt(station) {
  if (!station || !station.name) return null;
  return { legs: [], current: 0, start: { name: station.name, system: station.system } };
}
// Stations ordonnées du parcours : [{ name, system }, …] (legs.length + 1 entrées).
// Cas « de zéro » : pas de jambe mais un point de départ -> une seule station.
export function journeyStations(journey) {
  if (!journey) return [];
  if (!journey.legs.length) return journey.start ? [{ name: journey.start.name, system: journey.start.system }] : [];
  const st = [{ name: journey.legs[0].from, system: journey.legs[0].fromSystem }];
  for (const leg of journey.legs) st.push({ name: leg.to, system: leg.toSystem });
  return st;
}
// Dernière station (fin du parcours planifié), ou null.
export function journeyEnd(journey) {
  const st = journeyStations(journey);
  return st.length ? st[st.length - 1] : null;
}
// Les nouvelles jambes s'enchaînent-elles à la fin du parcours ? (leur départ == dernière station)
export function journeyConnects(journey, legs) {
  const end = journeyEnd(journey);
  return !!(end && legs.length && legs[0].from === end.name);
}
// Politique produit : ÉTENDRE si ça s'enchaîne (ajoute à la fin, garde la position), sinon REMPLACER.
export function addToJourney(journey, legs) {
  if (journeyConnects(journey, legs)) return { legs: journey.legs.concat(legs), current: journey.current };
  return startJourney(legs);
}
// Déplace la position courante (bornée à 0..legs.length).
export function setJourneyPosition(journey, i) {
  return { ...journey, current: Math.max(0, Math.min(journey.legs.length, i | 0)) };
}
// Jambe courante (stations[current] -> [current+1]), ou null si on est à la dernière station.
export function currentLeg(journey) {
  return journey && journey.current < journey.legs.length ? journey.legs[journey.current] : null;
}
// Profit total du parcours = somme des marges (les unités sont décidées ailleurs par vue).
export function journeyMargin(journey) {
  return journey ? journey.legs.reduce((a, l) => a + (l.margin || 0), 0) : 0;
}

// Encode un parcours en chaîne compacte auto-suffisante (pour localStorage / URL partageable).
// Chaque jambe -> tuple [from, fromSystem, to, toSystem, commodity, buyPrice, sellPrice, margin].
export function encodeJourney(journey) {
  if (!journey) return "";
  // Parcours « de zéro » : encode juste le point de départ.
  if (!journey.legs.length) return journey.start ? JSON.stringify({ c: 0, s: [journey.start.name, journey.start.system] }) : "";
  return JSON.stringify({
    c: journey.current,
    l: journey.legs.map((g) => [g.from, g.fromSystem, g.to, g.toSystem, g.commodity, g.buyPrice, g.sellPrice, g.margin]),
  });
}
// Reconstruit un parcours depuis la chaîne (null si vide/invalide). Robuste aux entrées malformées.
export function decodeJourney(str) {
  if (!str) return null;
  try {
    const p = JSON.parse(str);
    if (!p) return null;
    // Parcours « de zéro » : juste un point de départ.
    if (Array.isArray(p.s) && p.s[0]) return { legs: [], current: 0, start: { name: p.s[0], system: p.s[1] } };
    if (!Array.isArray(p.l) || !p.l.length) return null;
    const legs = p.l.map((a) => ({ from: a[0], fromSystem: a[1], to: a[2], toSystem: a[3], commodity: a[4], buyPrice: a[5], sellPrice: a[6], margin: a[7] }));
    return { legs, current: Math.max(0, Math.min(legs.length, p.c | 0)) };
  } catch {
    return null;
  }
}
