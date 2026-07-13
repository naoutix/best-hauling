"use strict";

// État global
let ROUTES = [];
let LOOPS = [];
let view = "routes"; // "routes" | "loops"
let sortKey = "score";
let sortDir = -1; // -1 = décroissant, 1 = croissant
let loopSortKey = "score";
let loopSortDir = -1;

const STATE_KEY = "best-hauling-state";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString("fr-FR"));

// Échappe toute chaîne insérée dans innerHTML. Les données UEX sont communautaires
// (nicknames de terminaux, etc. potentiellement soumis par des utilisateurs) : on les
// traite comme non fiables pour éviter toute injection HTML.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Formatte le nom d'un système en badge coloré.
function sysBadge(system) {
  const cls = esc(system.toLowerCase());
  return `<span class="sys ${cls}">${esc(system)}</span>`;
}

// Marqueur pour les avant-postes (élévateur de fret peu fiable).
function outpostTag(isOutpost) {
  return isOutpost ? ' <span class="outpost" title="Avant-poste : élévateur de fret parfois en panne">⚠ avant-poste</span>' : "";
}

// Icône emoji par catégorie de commodité (repère visuel).
const KIND_ICON = {
  metal: "🔩", alloy: "⛓️", mineral: "💎", raw: "⛏️", nonmetal: "🪨",
  gas: "💨", halogen: "⚗️", fuel: "⛽",
  agricultural: "🌾", food: "🍎", natural: "🌿", organic: "🧬",
  drug: "☠️", vice: "🍸", medical: "⚕️",
  scrap: "♻️", waste: "🗑️", manmade: "⚙️", explosive: "💥",
  temporary: "⏳", other: "📦",
};
function commodityIcon(kind) {
  const k = kind || "other";
  const emoji = KIND_ICON[k] || KIND_ICON.other;
  return `<span class="cicon k-${esc(k)}" title="${esc(k)}">${emoji}</span>`;
}

// Marqueur pour les commodités illégales (risque de scan / zones de sécurité).
function illegalTag(isIllegal) {
  return isIllegal ? ' <span class="illegal" title="Commodité illégale : contrebande, risque de scan">⛔ illégal</span>' : "";
}

// Estimation grossière du temps de trajet (minutes) depuis la distance UEX
// (unité orbite→orbite) : manutention aux terminaux + trajet + saut inter-système.
// Constantes approximatives — servent surtout à classer les routes entre elles.
const HANDLING = 3, PER_DIST = 0.06, JUMP = 4;
function tripMinutes(distance, cross) {
  return 2 * HANDLING + (distance || 0) * PER_DIST + (cross ? JUMP : 0);
}
function loopMinutes(distance, cross) {
  return 4 * HANDLING + (distance || 0) * PER_DIST + (cross ? 2 * JUMP : 0);
}

// ---------- Fiabilité : fraîcheur, statut de stock, aberrations ----------
// Âge d'un relevé en jours (null si date inconnue).
function ageDays(updated) {
  if (!updated) return null;
  return (Date.now() / 1000 - updated) / 86400;
}
// Âge d'une route/boucle = le relevé le plus ancien des deux extrémités.
function pairAge(a, b) {
  const u = a && b ? Math.min(a, b) : a || b || 0;
  return ageDays(u);
}
// Petite pastille colorée « il y a Xj/Xh » selon l'âge.
function freshChip(updated) {
  const d = ageDays(updated);
  if (d == null) return '<span class="fresh f-old" title="Date de relevé inconnue">?</span>';
  let cls = "f-good", label;
  if (d < 1) { cls = "f-good"; label = d < 1 / 24 ? "<1 h" : Math.round(d * 24) + " h"; }
  else { label = Math.round(d) + " j"; cls = d < 3 ? "f-good" : d < 7 ? "f-ok" : "f-old"; }
  return `<span class="fresh ${cls}" title="Relevé UEX il y a ${label}">${label}</span>`;
}

// Légendes de statut d'inventaire UEX (couleurs officielles).
const BUY_STATUS = { 1: ["Vide", "red"], 2: ["Très bas", "red"], 3: ["Bas", "orange"], 4: ["Moyen", "blue"], 5: ["Élevé", "blue"], 6: ["Très élevé", "green"], 7: ["Plein", "green"] };
const SELL_STATUS = { 1: ["Forte demande", "green"], 2: ["Bonne demande", "green"], 3: ["Demande correcte", "blue"], 4: ["Demande moyenne", "blue"], 5: ["Demande faible", "orange"], 6: ["Demande très faible", "red"], 7: ["Saturé (aucune demande)", "red"] };
function statusDot(code, side) {
  const legend = side === "buy" ? BUY_STATUS : SELL_STATUS;
  const s = legend[code];
  if (!s) return "";
  return `<span class="sdot s-${s[1]}" title="${side === "buy" ? "Stock à l'achat" : "Demande à la vente"} : ${s[0]}"></span>`;
}

// Flag « à vérifier » : donnée trop vieille (>10 j) ou prix qui s'écarte fortement
// de la moyenne UEX (souvent un relevé erroné ou périmé).
function suspectTag(r) {
  const d = pairAge(r.buy.updated, r.sell.updated);
  const stale = d != null && d > 10;
  const deviant = r.refSell > 0 && r.refBuy > 0 && (r.sell.price > r.refSell * 1.5 || r.buy.price < r.refBuy * 0.67);
  if (!stale && !deviant) return "";
  const why = stale ? "relevé de plus de 10 jours" : "prix très éloigné de la moyenne UEX";
  return ` <span class="suspect" title="À vérifier en jeu : ${why}">⚠ à vérifier</span>`;
}

// Comparateur de tri qui renvoie toujours les valeurs nulles en bas.
function bySort(key, dir) {
  return (a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    // Tri des chaînes (ex : commodité) sensible à la locale, pour trier les accents correctement.
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv, "fr") * dir;
    return av > bv ? dir : av < bv ? -dir : 0;
  };
}

// Nombre d'unités achetables selon les contraintes actives. Renvoie Infinity si aucune
// contrainte de volume n'est active (soute ET budget désactivés) -> on classe alors par marge.
// f = { cargo, budget, capStock, useCargo, useBudget } (issu de readFilters()).
function computeUnits(price, stock, demand, f) {
  const byCargo = f.useCargo ? f.cargo : Infinity;
  const byBudget = f.useBudget && f.budget > 0 ? Math.floor(f.budget / price) : Infinity;
  let units = Math.min(byCargo, byBudget);
  if (f.capStock) {
    if (stock > 0) units = Math.min(units, stock); // stock dispo à l'achat
    if (demand > 0) units = Math.min(units, demand); // demande à la vente
  }
  if (isFinite(units) && units < 0) units = 0;
  return units;
}

// ---------- Score composite (tri « intelligent ») ----------
// Combine la valeur (profit/heure si borné, sinon marge/SCU) avec la fiabilité :
// fraîcheur du relevé et disponibilité (stock à l'achat × demande à la vente).
function freshnessFactor(age) {
  if (age == null) return 0.5;          // date inconnue : pénalité modérée
  return Math.max(0.2, 1 - age / 14);   // 1.0 tout frais -> 0.2 au-delà de ~11 j
}
function availabilityFactor(stock, demand) {
  if (!stock && !demand) return 0.65;   // relevé de volume absent : neutre-bas
  const m = Math.min(stock || 0, demand || 0);
  return 0.3 + 0.7 * (m / (m + 120));   // saturation : ~0.65 à 120 SCU, ~0.88 à 500
}

// Normalise les scores bruts d'une liste sur 0-100 (100 = meilleur de la vue courante).
function normalizeScores(rows) {
  const max = rows.reduce((m, r) => Math.max(m, r.rawScore || 0), 0);
  rows.forEach((r) => (r.score = max > 0 ? Math.round((r.rawScore / max) * 100) : 0));
}

// ---------- Corrections locales (prix & stock) ----------
// L'utilisateur peut corriger un prix ou un volume (stock à l'achat / demande à la vente)
// quand le relevé UEX est faux. Stocké UNIQUEMENT en local (localStorage), jamais partagé
// ni dans l'URL. Clé : « commodité|terminal|side » (side = "buy" | "vol"… non : "buy"/"sell").
const OV_KEY = "best-hauling-overrides";
let OVERRIDES = {}; // { "Commodité|Terminal|buy": { price?, vol? }, ... }

function loadOverrides() {
  try { OVERRIDES = JSON.parse(localStorage.getItem(OV_KEY)) || {}; } catch { OVERRIDES = {}; }
}
function saveOverrides() {
  try { localStorage.setItem(OV_KEY, JSON.stringify(OVERRIDES)); } catch {}
}
const ovKey = (commodity, terminal, side) => `${commodity}|${terminal}|${side}`;
const ovCount = () => Object.keys(OVERRIDES).length;

// Renvoie prix/volume effectifs (corrigés si une correction locale existe) + drapeaux.
function effVals(commodity, terminal, side, price, vol) {
  const o = OVERRIDES[ovKey(commodity, terminal, side)];
  return {
    price: o && o.price != null ? o.price : price,
    vol: o && o.vol != null ? o.vol : vol,
    oprice: !!(o && o.price != null),
    ovol: !!(o && o.vol != null),
  };
}

// Enregistre (ou efface) une correction. field = "price" | "vol". value null/"" = efface ce champ.
function setOverride(commodity, terminal, side, field, value) {
  const k = ovKey(commodity, terminal, side);
  const o = OVERRIDES[k] || {};
  const n = value == null || value === "" ? NaN : Math.max(0, Math.round(Number(value)));
  if (Number.isFinite(n)) o[field] = n;
  else delete o[field];
  if (Object.keys(o).length) OVERRIDES[k] = o;
  else delete OVERRIDES[k];
  saveOverrides();
}
function resetOverrides() { OVERRIDES = {}; saveOverrides(); }

// Applique les corrections à une paire buy/sell et renvoie des copies patchées + marge/roi.
function applyOverrides(commodity, buy, sell) {
  const b = effVals(commodity, buy.terminal, "buy", buy.price, buy.stock);
  const s = effVals(commodity, sell.terminal, "sell", sell.price, sell.demand);
  const nb = { ...buy, price: b.price, stock: b.vol, ovPrice: b.oprice, ovVol: b.ovol };
  const ns = { ...sell, price: s.price, demand: s.vol, ovPrice: s.oprice, ovVol: s.ovol };
  const margin = ns.price - nb.price;
  const roi = nb.price > 0 ? Math.round((margin / nb.price) * 1000) / 10 : 0;
  return { buy: nb, sell: ns, margin, roi };
}

// Calcule les champs dérivés d'une route selon les entrées utilisateur (corrections comprises).
function evaluate(r, f) {
  const { buy, sell, margin, roi } = applyOverrides(r.commodity, r.buy, r.sell);
  const units = computeUnits(buy.price, buy.stock, sell.demand, f);
  const bounded = isFinite(units);
  const profit = bounded ? units * margin : null;
  const minutes = tripMinutes(r.distance, !r.same_system);
  const profitHour = profit == null ? null : (profit * 60) / minutes;
  const base = profit == null ? margin : profitHour;
  const rawScore =
    base * freshnessFactor(pairAge(buy.updated, sell.updated)) * availabilityFactor(buy.stock, sell.demand);
  return {
    ...r,
    buy, sell, margin, roi,
    buyPrice: buy.price,
    sellPrice: sell.price,
    units: bounded ? units : null,
    investment: bounded ? units * buy.price : null,
    profit,
    minutes,
    profitHour,
    rawScore,
  };
}

// Cellule visuelle du score : mini-barre + valeur.
function scoreCell(score) {
  const tier = score >= 70 ? "s-good" : score >= 40 ? "s-ok" : "s-low";
  return `<div class="score-cell"><span class="scorebar ${tier}"><i style="width:${score}%"></i></span><b>${score}</b></div>`;
}

// Valeur éditable (clic pour corriger localement). side = "buy"|"sell", field = "price"|"vol".
function editv(commodity, terminal, side, field, value, ov) {
  return `<span class="editv${ov ? " ov" : ""}" data-c="${esc(commodity)}" data-t="${esc(terminal)}" data-s="${side}" data-f="${field}" data-v="${value}" role="button" tabindex="0" title="Clic pour corriger localement ce chiffre">${fmt(value)}${ov ? '<span class="ovmark" title="Corrigé localement">✎</span>' : ""}</span>`;
}

// Lit l'état de tous les contrôles de filtre (partagé par les deux vues).
function readFilters() {
  return {
    cargo: Math.max(0, Number($("cargo").value) || 0),
    budget: Math.max(0, Number($("budget").value) || 0),
    capStock: $("capStock").checked,
    useCargo: $("useCargo").checked,
    useBudget: $("useBudget").checked,
    sameOnly: $("sameSystem").checked,
    noOutpost: $("noOutpost").checked,
    legalOnly: $("legalOnly").checked,
    sysFilter: $("system").value,
    maxAge: Number($("freshness").value) || 0,
    q: $("search").value.trim().toLowerCase(),
  };
}

function render() {
  const f = readFilters();
  const { sameOnly, noOutpost, legalOnly, sysFilter, maxAge, q } = f;

  let rows = ROUTES.filter((r) => {
    if (sameOnly && !r.same_system) return false;
    if (noOutpost && (r.buy.outpost || r.sell.outpost)) return false;
    if (legalOnly && r.illegal) return false;
    if (sysFilter && r.buy.system !== sysFilter) return false;
    if (maxAge) {
      const a = pairAge(r.buy.updated, r.sell.updated);
      if (a == null || a > maxAge) return false;
    }
    if (q && !r.commodity.toLowerCase().includes(q)) return false;
    return true;
  }).map((r) => evaluate(r, f));

  normalizeScores(rows);
  rows.sort(bySort(sortKey, sortDir));

  $("rows").innerHTML = rows.map(routeRowHTML).join("");
  $("empty").hidden = rows.length > 0;
}

// Ligne de tableau pour une route évaluée (partagée par « Trajets simples » et « En route »).
function routeRowHTML(r) {
  return `
      <tr>
        <td class="loc"><div class="commodity-cell">${commodityIcon(r.kind)}<span>${esc(r.commodity)}${illegalTag(r.illegal)}${suspectTag(r)}</span></div></td>
        <td>
          <div>${esc(r.buy.terminal)}${sysBadge(r.buy.system)}${outpostTag(r.buy.outpost)}</div>
          <div class="loc-sub">${esc(r.buy.planet)} · ${editv(r.commodity, r.buy.terminal, "buy", "price", r.buy.price, r.buy.ovPrice)} aUEC · ${statusDot(r.buy.status, "buy")}<span class="stock" title="Stock disponible à l'achat (relevé UEX)">stock ${editv(r.commodity, r.buy.terminal, "buy", "vol", r.buy.stock, r.buy.ovVol)} SCU</span> · ${freshChip(r.buy.updated)}</div>
        </td>
        <td>
          <div>${esc(r.sell.terminal)}${sysBadge(r.sell.system)}${outpostTag(r.sell.outpost)}</div>
          <div class="loc-sub">${esc(r.sell.planet)} · ${editv(r.commodity, r.sell.terminal, "sell", "price", r.sell.price, r.sell.ovPrice)} aUEC · ${statusDot(r.sell.status, "sell")}<span class="stock" title="Demande / stock à la vente (relevé UEX)">demande ${editv(r.commodity, r.sell.terminal, "sell", "vol", r.sell.demand, r.sell.ovVol)} SCU</span> · ${freshChip(r.sell.updated)}${r.same_system ? "" : ' <span class="cross">⚡ saut inter-système</span>'}</div>
        </td>
        <td>${scoreCell(r.score)}</td>
        <td class="num">${fmt(r.margin)}</td>
        <td class="num roi-badge">${r.roi}%</td>
        <td class="num">${fmt(r.units)}</td>
        <td class="num">${fmt(r.investment)}</td>
        <td class="num profit">${fmt(r.profit)}</td>
        <td class="num profit" title="Estimation ${Math.round(r.minutes)} min/voyage">${fmt(r.profitHour)}</td>
      </tr>`;
}

// ---------- Vue "Boucles aller-retour" ----------
// Corrige un segment de boucle (achat au terminal `buyT`, vente au terminal `sellT`).
function effLeg(leg, buyT, sellT) {
  const b = effVals(leg.commodity, buyT, "buy", leg.buyPrice, leg.stock);
  const s = effVals(leg.commodity, sellT, "sell", leg.sellPrice, leg.demand);
  return { ...leg, buyPrice: b.price, stock: b.vol, sellPrice: s.price, demand: s.vol, margin: s.price - b.price };
}

function evaluateLoop(l, f) {
  const out = effLeg(l.out, l.a.terminal, l.b.terminal);
  const back = effLeg(l.back, l.b.terminal, l.a.terminal);
  const loopMargin = out.margin + back.margin;
  const uOut = computeUnits(out.buyPrice, out.stock, out.demand, f);
  const uBack = computeUnits(back.buyPrice, back.stock, back.demand, f);
  const bounded = isFinite(uOut) && isFinite(uBack);
  const cross = l.a.system !== l.b.system;
  const minutes = loopMinutes(l.distance, cross);
  const profit = bounded ? uOut * out.margin + uBack * back.margin : null;
  const profitHour = profit == null ? null : (profit * 60) / minutes;
  const base = profit == null ? loopMargin : profitHour;
  const rawScore =
    base *
    freshnessFactor(pairAge(out.updated, back.updated)) *
    availabilityFactor(Math.min(out.stock, back.stock), Math.min(out.demand, back.demand));
  return {
    ...l,
    out, back, loopMargin,
    cross,
    unitsOut: bounded ? uOut : null,
    unitsBack: bounded ? uBack : null,
    units: bounded ? uOut + uBack : null,
    investment: bounded ? Math.max(uOut * out.buyPrice, uBack * back.buyPrice) : null,
    profit,
    minutes,
    profitHour,
    rawScore,
  };
}

function renderLoops() {
  const f = readFilters();
  const { sameOnly, noOutpost, legalOnly, sysFilter, maxAge, q } = f;

  let rows = LOOPS.filter((l) => {
    if (sameOnly && l.a.system !== l.b.system) return false;
    if (noOutpost && (l.a.outpost || l.b.outpost)) return false;
    if (legalOnly && (l.out.illegal || l.back.illegal)) return false;
    if (sysFilter && l.a.system !== sysFilter && l.b.system !== sysFilter) return false;
    if (maxAge) {
      const a = pairAge(l.out.updated, l.back.updated);
      if (a == null || a > maxAge) return false;
    }
    if (q && !(l.out.commodity.toLowerCase().includes(q) || l.back.commodity.toLowerCase().includes(q))) return false;
    return true;
  }).map((l) => evaluateLoop(l, f));

  normalizeScores(rows);
  rows.sort(bySort(loopSortKey, loopSortDir));

  $("loopRows").innerHTML = rows
    .map(
      (l) => `
      <tr>
        <td class="loc">
          <div>${esc(l.a.terminal)}${sysBadge(l.a.system)}${outpostTag(l.a.outpost)}</div>
          <div class="loc-sub">⇄ ${esc(l.b.terminal)}${sysBadge(l.b.system)}${outpostTag(l.b.outpost)}${l.cross ? ' <span class="cross">⚡ inter-système</span>' : ""} · ${freshChip(l.out.updated && l.back.updated ? Math.min(l.out.updated, l.back.updated) : l.out.updated || l.back.updated || 0)}</div>
        </td>
        <td>
          <div class="commodity-cell">${commodityIcon(l.out.kind)}<span>${esc(l.out.commodity)}${illegalTag(l.out.illegal)}</span></div>
          <div class="loc-sub">${fmt(l.out.buyPrice)} → ${fmt(l.out.sellPrice)} · marge ${fmt(l.out.margin)}</div>
        </td>
        <td>
          <div class="commodity-cell">${commodityIcon(l.back.kind)}<span>${esc(l.back.commodity)}${illegalTag(l.back.illegal)}</span></div>
          <div class="loc-sub">${fmt(l.back.buyPrice)} → ${fmt(l.back.sellPrice)} · marge ${fmt(l.back.margin)}</div>
        </td>
        <td>${scoreCell(l.score)}</td>
        <td class="num">${fmt(l.loopMargin)}</td>
        <td class="num">${l.units == null ? "—" : fmt(l.unitsOut) + " + " + fmt(l.unitsBack)}</td>
        <td class="num profit">${fmt(l.profit)}</td>
        <td class="num profit" title="Estimation ${Math.round(l.minutes)} min/boucle">${fmt(l.profitHour)}</td>
      </tr>`
    )
    .join("");

  $("empty").hidden = rows.length > 0;
}

// ---------- Mode « En route » (trajet dirigé) + manifeste multi-commodité ----------
let MARKET = null;            // graphe d'échange, chargé à la demande
let enrouteReady = false;     // datalist/destSystem peuplés une seule fois
let originMap = new Map();    // libellé « Nom — Système » -> index terminal
let enrouteOrigin = null;     // index du terminal de départ sélectionné

async function loadMarket() {
  if (!MARKET) {
    MARKET = await fetch("data/market.json").then((r) => r.json()).catch(() => ({ terminals: [], commodities: [] }));
  }
  return MARKET;
}

// Peuple la liste des terminaux de départ (ceux où l'on peut acheter). Idempotent.
function setupEnRoute() {
  if (enrouteReady) return;
  const seen = new Set();
  const opts = [];
  MARKET.commodities.forEach((c) => c.buys.forEach((b) => {
    if (!seen.has(b[0])) {
      seen.add(b[0]);
      const t = MARKET.terminals[b[0]];
      const label = `${t.name} — ${t.system}`;
      originMap.set(label, b[0]);
      opts.push(label);
    }
  }));
  opts.sort((a, b) => a.localeCompare(b, "fr"));
  $("originList").innerHTML = opts.map((l) => `<option value="${esc(l)}"></option>`).join("");
  enrouteReady = true;
  resolveOrigin(); // au cas où une valeur a été restaurée
}

// Résout le terminal de départ depuis le texte du champ (libellé exact).
function resolveOrigin() {
  const v = $("origin").value.trim();
  enrouteOrigin = originMap.has(v) ? originMap.get(v) : null;
}

// Construit un objet « route » (compatible evaluate/routeRowHTML) depuis un achat + une vente.
function dealFrom(c, b, s) {
  const bt = MARKET.terminals[b[0]], st = MARKET.terminals[s[0]];
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

// Meilleure vente par commodité depuis le terminal `origin`, filtrée par système d'arrivée.
function enRouteDeals(origin, destSystem) {
  const deals = [];
  MARKET.commodities.forEach((c) => {
    const b = c.buys.find((x) => x[0] === origin);
    if (!b) return;
    let best = null;
    for (const s of c.sells) {
      if (s[0] === origin) continue;
      if (destSystem && MARKET.terminals[s[0]].system !== destSystem) continue;
      if (!best || s[1] > best[1]) best = s;
    }
    if (best && best[1] > b[1]) deals.push(dealFrom(c, b, best));
  });
  return deals;
}

// Manifeste : destination (terminal) qui maximise le profit d'un chargement multi-commodité
// depuis `origin`, soute remplie par marge décroissante. Toujours plafonné par stock/demande
// (c'est justement ce qui force à diversifier). Null si la soute n'est pas contrainte.
function bestManifest(origin, destSystem, f) {
  if (!f.useCargo || !(f.cargo > 0)) return null;
  const ot = MARKET.terminals[origin];
  const byDest = new Map();
  MARKET.commodities.forEach((c) => {
    if (f.legalOnly && c.illegal) return;
    const b = c.buys.find((x) => x[0] === origin);
    if (!b) return;
    const eb = effVals(c.name, ot.name, "buy", b[1], b[2]); // prix/stock corrigés
    c.sells.forEach((s) => {
      if (s[0] === origin) return;
      const st = MARKET.terminals[s[0]];
      if (destSystem && st.system !== destSystem) return;
      if (f.noOutpost && st.outpost) return;
      const es = effVals(c.name, st.name, "sell", s[1], s[2]);
      const margin = es.price - eb.price;
      if (margin <= 0) return;
      if (!byDest.has(s[0])) byDest.set(s[0], []);
      byDest.get(s[0]).push({ name: c.name, kind: c.kind, illegal: c.illegal, buyPrice: eb.price, stock: eb.vol, sellPrice: es.price, demand: es.vol, margin });
    });
  });

  let best = null;
  for (const [dest, items] of byDest) {
    items.sort((a, b) => b.margin - a.margin);
    let cargoLeft = f.cargo;
    let budgetLeft = f.useBudget && f.budget > 0 ? f.budget : Infinity;
    const lines = [];
    let profit = 0;
    for (const it of items) {
      if (cargoLeft <= 0 || budgetLeft <= 0) break;
      let u = cargoLeft;
      if (it.stock > 0) u = Math.min(u, it.stock);
      if (it.demand > 0) u = Math.min(u, it.demand);
      if (isFinite(budgetLeft)) u = Math.min(u, Math.floor(budgetLeft / it.buyPrice));
      if (u <= 0) continue;
      lines.push({ ...it, units: u, cap: u });
      cargoLeft -= u; budgetLeft -= u * it.buyPrice; profit += u * it.margin;
    }
    if (lines.length && (!best || profit > best.profit)) {
      const dt = MARKET.terminals[dest];
      best = { origin: ot, dest: dt, destIdx: dest, cross: ot.system !== dt.system, lines, profit, cargo: f.cargo };
    }
  }
  return best;
}

let currentManifest = null; // manifeste courant, mutable (édition SCU + suggestions ajoutées)

const isOv = (commodity, terminal, side, field) => {
  const o = OVERRIDES[ovKey(commodity, terminal, side)];
  return !!(o && o[field] != null);
};

function manifestTotalsHTML(profit, scu, cargo, invest, cross) {
  const empty = cargo - scu;
  const profitHour = (profit * 60) / tripMinutes(0, cross);
  return `Profit <b class="profit">${fmt(profit)}</b> aUEC · <b>${fmt(scu)}</b>/${fmt(cargo)} SCU${empty > 0 ? ` · ${fmt(empty)} SCU vides` : ""} · invest. ${fmt(invest)} · ~${fmt(profitHour)}/h`;
}

// Espace/budget restants d'après les SCU actuellement affectés.
function manifestRemaining() {
  const m = currentManifest;
  const scu = m.lines.reduce((a, l) => a + l.units, 0);
  const invest = m.lines.reduce((a, l) => a + l.units * l.buyPrice, 0);
  const budgetLeft = m.f.useBudget && m.f.budget > 0 ? m.f.budget - invest : Infinity;
  return { scu, invest, cargoLeft: m.cargo - scu, budgetLeft };
}

// Commodités qui pourraient remplir l'espace libre (même origine -> même destination), non chargées.
function suggestionsFor() {
  const m = currentManifest;
  const have = new Set(m.lines.map((l) => l.name));
  const out = [];
  MARKET.commodities.forEach((c) => {
    if (have.has(c.name) || (m.f.legalOnly && c.illegal)) return;
    const b = c.buys.find((x) => x[0] === m.originIdx);
    const s = c.sells.find((x) => x[0] === m.destIdx);
    if (!b || !s) return;
    const eb = effVals(c.name, m.origin.name, "buy", b[1], b[2]);
    const es = effVals(c.name, m.dest.name, "sell", s[1], s[2]);
    const margin = es.price - eb.price;
    if (margin <= 0) return;
    out.push({ name: c.name, kind: c.kind, illegal: c.illegal, buyPrice: eb.price, stock: eb.vol, sellPrice: es.price, demand: es.vol, margin });
  });
  return out.sort((a, b) => b.margin - a.margin);
}

// Unités ajoutables d'une commodité candidate compte tenu de l'espace/budget restant.
function addableUnits(it, rem) {
  let u = rem.cargoLeft;
  if (it.stock > 0) u = Math.min(u, it.stock);
  if (it.demand > 0) u = Math.min(u, it.demand);
  if (isFinite(rem.budgetLeft)) u = Math.min(u, Math.floor(rem.budgetLeft / it.buyPrice));
  return Math.max(0, u);
}

function renderSuggestions() {
  const box = $("manifestSuggest");
  if (!box || !currentManifest) return;
  const rem = manifestRemaining();
  if (rem.cargoLeft <= 0) { box.innerHTML = ""; return; }
  const sugg = suggestionsFor().map((it) => ({ it, u: addableUnits(it, rem) })).filter((x) => x.u >= 1).slice(0, 6);
  if (!sugg.length) {
    box.innerHTML = `<div class="suggest-head">${fmt(rem.cargoLeft)} SCU libres — aucune autre commodité rentable vers cette destination.</div>`;
    return;
  }
  box.innerHTML =
    `<div class="suggest-head">Remplir les ${fmt(rem.cargoLeft)} SCU libres — suggestions :</div>` +
    sugg.map(({ it, u }) =>
      `<div class="sline">${commodityIcon(it.kind)}` +
      `<span class="mname">${esc(it.name)}${illegalTag(it.illegal)}</span>` +
      `<span class="mstock">stock ${fmt(it.stock)} · dem. ${fmt(it.demand)}</span>` +
      `<span class="mprice">${fmt(it.buyPrice)} → ${fmt(it.sellPrice)} · marge ${fmt(it.margin)}</span>` +
      `<button class="suggest-add" data-name="${esc(it.name)}" title="Ajouter au manifeste">+ ${fmt(u)} SCU</button></div>`
    ).join("");
}

function addSuggestion(name) {
  const it = suggestionsFor().find((x) => x.name === name);
  if (!it) return;
  const u = addableUnits(it, manifestRemaining());
  if (u <= 0) return;
  currentManifest.lines.push({ ...it, units: u, cap: u });
  paintManifest();
}

// Dessine le manifeste courant : totaux + lignes (SCU/prix/stock éditables) + suggestions.
function paintManifest() {
  const m = currentManifest;
  const card = $("manifest");
  let profit = 0, invest = 0, scu = 0;
  m.lines.forEach((l) => { profit += l.units * l.margin; invest += l.units * l.buyPrice; scu += l.units; });
  card.hidden = false;
  card.innerHTML =
    `<div class="manifest-head">
      <span class="manifest-title">◈ Manifeste — ${esc(m.origin.name)}${sysBadge(m.origin.system)} → ${esc(m.dest.name)}${sysBadge(m.dest.system)}${m.cross ? ' <span class="cross">⚡ inter-système</span>' : ""}</span>
      <span class="manifest-tot" id="manifestTot">${manifestTotalsHTML(profit, scu, m.cargo, invest, m.cross)}</span>
    </div>
    <div class="manifest-lines">` +
    m.lines.map((l, i) =>
      `<div class="mline">${commodityIcon(l.kind)}` +
      `<span class="mqtywrap"><input type="number" class="mqty-input" min="0" max="${l.cap}" value="${l.units}" data-i="${i}" data-margin="${l.margin}" data-buy="${l.buyPrice}" data-cap="${l.cap}" title="Réduis si le stock in-game est plus bas" aria-label="SCU ${esc(l.name)}"><span class="munit">SCU</span></span>` +
      `<span class="mname">${esc(l.name)}${illegalTag(l.illegal)}</span>` +
      `<span class="mstock">stock ${editv(l.name, m.origin.name, "buy", "vol", l.stock, isOv(l.name, m.origin.name, "buy", "vol"))} · dem. ${editv(l.name, m.dest.name, "sell", "vol", l.demand, isOv(l.name, m.dest.name, "sell", "vol"))}</span>` +
      `<span class="mprice">${editv(l.name, m.origin.name, "buy", "price", l.buyPrice, isOv(l.name, m.origin.name, "buy", "price"))} → ${editv(l.name, m.dest.name, "sell", "price", l.sellPrice, isOv(l.name, m.dest.name, "sell", "price"))}</span>` +
      `<span class="mprofit profit">+${fmt(l.units * l.margin)}</span></div>`
    ).join("") +
    `</div><div id="manifestSuggest" class="manifest-suggest"></div>`;
  renderSuggestions();
}

// Recalcule totaux + profit par ligne d'après les SCU saisis, et rafraîchit les suggestions.
function updateManifestTotals() {
  if (!currentManifest) return;
  let profit = 0, invest = 0, scu = 0;
  document.querySelectorAll("#manifest .mqty-input").forEach((inp) => {
    const i = Number(inp.dataset.i);
    const cap = Number(inp.dataset.cap);
    let u = Math.floor(Number(inp.value));
    if (!Number.isFinite(u) || u < 0) u = 0;
    if (u > cap) { u = cap; inp.value = String(cap); }
    if (currentManifest.lines[i]) currentManifest.lines[i].units = u;
    profit += u * Number(inp.dataset.margin);
    invest += u * Number(inp.dataset.buy);
    scu += u;
    inp.closest(".mline").querySelector(".mprofit").textContent = "+" + fmt(u * Number(inp.dataset.margin));
  });
  $("manifestTot").innerHTML = manifestTotalsHTML(profit, scu, currentManifest.cargo, invest, currentManifest.cross);
  renderSuggestions();
}

function renderManifest(origin, destSystem, f) {
  const card = $("manifest");
  currentManifest = null;
  if (enrouteOrigin == null) { card.hidden = true; return; }
  if (!f.useCargo || !(f.cargo > 0)) {
    card.hidden = false;
    card.innerHTML = `<div class="manifest-hint">Active la <b>soute (SCU)</b> pour calculer un manifeste de remplissage.</div>`;
    return;
  }
  const man = bestManifest(origin, destSystem, f);
  if (!man) {
    card.hidden = false;
    card.innerHTML = `<div class="manifest-hint">Aucun chargement rentable depuis ce terminal vers cette destination.</div>`;
    return;
  }
  man.originIdx = origin;
  man.f = f;
  currentManifest = man;
  paintManifest();
}

function renderEnRoute() {
  if (!MARKET) { loadMarket().then(() => { setupEnRoute(); renderEnRoute(); }); return; }
  if (!enrouteReady) setupEnRoute();
  const f = readFilters();
  const emptyMsg = $("empty");

  renderManifest(enrouteOrigin, $("destSystem").value, f);

  if (enrouteOrigin == null) {
    $("enrouteRows").innerHTML = "";
    emptyMsg.hidden = false;
    emptyMsg.textContent = "Choisis un terminal de départ pour voir le fret à emporter.";
    return;
  }

  const destSystem = $("destSystem").value;
  let deals = enRouteDeals(enrouteOrigin, destSystem)
    .filter((r) => {
      if (f.legalOnly && r.illegal) return false;
      if (f.noOutpost && (r.buy.outpost || r.sell.outpost)) return false;
      if (f.sameOnly && !r.same_system) return false;
      if (f.maxAge) { const a = pairAge(r.buy.updated, r.sell.updated); if (a == null || a > f.maxAge) return false; }
      if (f.q && !r.commodity.toLowerCase().includes(f.q)) return false;
      return true;
    })
    .map((r) => evaluate(r, f));

  normalizeScores(deals);
  deals.sort(bySort(sortKey, sortDir));
  $("enrouteRows").innerHTML = deals.map(routeRowHTML).join("");
  emptyMsg.hidden = deals.length > 0;
  if (!deals.length) emptyMsg.textContent = "Aucun fret rentable depuis ce terminal avec ces filtres.";
}

// Bascule entre les vues et rafraîchit la bonne table.
function refresh() {
  if (view === "loops") renderLoops();
  else if (view === "enroute") renderEnRoute();
  else render();
  saveState();
}
function switchView(v) {
  view = v;
  $("viewRoutes").classList.toggle("active", v === "routes");
  $("viewLoops").classList.toggle("active", v === "loops");
  $("viewEnroute").classList.toggle("active", v === "enroute");
  $("routes").hidden = v !== "routes";
  $("loops").hidden = v !== "loops";
  $("enroute").hidden = v !== "enroute";
  $("enrouteControls").hidden = v !== "enroute";
  if (v !== "enroute") $("manifest").hidden = true;
  refresh();
}

function setupSort() {
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        sortDir = key === "commodity" ? 1 : -1;
      }
      document.querySelectorAll("#routes th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(sortDir === -1 ? "sorted-desc" : "sorted-asc");
      render();
      saveState();
    });
  });
}

function setupLoopSort() {
  document.querySelectorAll("th[data-sort-loop]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortLoop;
      if (loopSortKey === key) loopSortDir *= -1;
      else { loopSortKey = key; loopSortDir = -1; }
      document.querySelectorAll("#loops th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(loopSortDir === -1 ? "sorted-desc" : "sorted-asc");
      renderLoops();
      saveState();
    });
  });
}

// Charge les vaisseaux et gère une autocomplétion maison (filtre par sous-chaîne,
// fiable sur tous les navigateurs, avec navigation clavier).
async function loadShips() {
  const ships = await fetch("data/ships.json").then((r) => r.json()).catch(() => []);
  // Tri par capacité de soute décroissante : les plus gros haulers apparaissent en premier.
  ships.sort((a, b) => b.scu - a.scu);
  const input = $("ship");
  const list = $("shipList");
  const byName = new Map(ships.map((s) => [s.name.toLowerCase(), s.scu]));
  let matches = [];
  let active = -1;

  function hide() {
    list.hidden = true;
    list.innerHTML = "";
    active = -1;
    input.setAttribute("aria-expanded", "false");
  }

  // q vide -> toute la liste (parcours au focus) ; sinon filtre par sous-chaîne (max 12).
  function show(q) {
    const pool = q ? ships.filter((s) => s.name.toLowerCase().includes(q)) : ships;
    matches = q ? pool.slice(0, 12) : pool;
    if (!matches.length) return hide();
    active = 0;
    list.innerHTML = matches
      .map(
        (s, i) =>
          `<li role="option" data-i="${i}" class="${i === 0 ? "active" : ""}">` +
          `<span>${esc(s.name)}</span><span class="scu">${s.scu.toLocaleString("fr-FR")} SCU</span></li>`
      )
      .join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function showCard(s) {
    const card = $("shipCard");
    const img = $("shipImg");
    const wrap = img.parentElement;
    // N'accepte que des URL https:// (le flux communautaire pourrait contenir autre chose).
    if (s.photo && /^https:\/\//i.test(s.photo)) {
      wrap.style.display = "";
      img.onerror = () => (wrap.style.display = "none"); // masque si l'image échoue
      img.alt = s.name;
      img.src = s.photo;
    } else {
      wrap.style.display = "none";
    }
    $("shipCardName").textContent = s.name;
    $("shipCardScu").innerHTML = `Soute : <b>${s.scu.toLocaleString("fr-FR")} SCU</b>`;
    card.hidden = false;
  }

  function choose(s) {
    if (!s) return;
    input.value = s.name;
    $("cargo").value = s.scu;
    hide();
    showCard(s);
    refresh();
  }

  function highlight() {
    [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => show(input.value.trim().toLowerCase()));

  // Cliquer/placer le curseur dans le champ ouvre la liste sans avoir à taper.
  input.addEventListener("focus", () => show(input.value.trim().toLowerCase()));

  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      highlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === "Escape") {
      hide();
    }
  });

  // mousedown (et non click) pour devancer le blur du champ.
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    e.preventDefault();
    choose(matches[Number(li.dataset.i)]);
  });

  input.addEventListener("blur", () => setTimeout(hide, 150));

  // Modifier la soute à la main efface le nom du vaisseau et la carte.
  $("cargo").addEventListener("input", () => {
    const scu = byName.get(input.value.trim().toLowerCase());
    if (String(scu) !== $("cargo").value) {
      input.value = "";
      $("shipCard").hidden = true;
    }
  });
}

// ---------- Persistance & permaliens ----------
// L'état (filtres, tri, vue, vaisseau) est sauvé dans localStorage ET encodé dans le
// hash de l'URL, pour reprendre là où on s'est arrêté et partager une vue précise.
const STATE_FIELDS = ["cargo", "budget", "search", "system", "freshness", "ship", "origin", "destSystem"];
const STATE_CHECKS = ["useCargo", "useBudget", "sameSystem", "noOutpost", "legalOnly", "capStock"];
const safeKey = (k) => typeof k === "string" && /^[a-zA-Z]+$/.test(k); // anti-injection de sélecteur

let restoring = false; // évite de resauver pendant qu'on applique un état

function collectState() {
  const s = { v: view, sk: sortKey, sd: sortDir, lk: loopSortKey, ld: loopSortDir };
  STATE_FIELDS.forEach((id) => (s[id] = $(id).value));
  STATE_CHECKS.forEach((id) => (s[id] = $(id).checked ? 1 : 0));
  return s;
}

function saveState() {
  if (restoring) return;
  const params = new URLSearchParams();
  Object.entries(collectState()).forEach(([k, v]) => {
    if (v !== "" && v != null) params.set(k, v);
  });
  const str = params.toString();
  try { localStorage.setItem(STATE_KEY, str); } catch {}
  history.replaceState(null, "", str ? "#" + str : location.pathname + location.search);
}

function loadState() {
  let str = location.hash.replace(/^#/, "");
  if (!str) { try { str = localStorage.getItem(STATE_KEY) || ""; } catch {} }
  return str ? Object.fromEntries(new URLSearchParams(str)) : null;
}

// Positionne l'indicateur ▾/▴ sur la bonne colonne des deux tables.
function applySortIndicators() {
  document.querySelectorAll("#routes th, #loops th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
  if (safeKey(sortKey)) {
    const th = document.querySelector(`#routes th[data-sort="${sortKey}"]`);
    if (th) th.classList.add(sortDir === -1 ? "sorted-desc" : "sorted-asc");
  }
  if (safeKey(loopSortKey)) {
    const th = document.querySelector(`#loops th[data-sort-loop="${loopSortKey}"]`);
    if (th) th.classList.add(loopSortDir === -1 ? "sorted-desc" : "sorted-asc");
  }
}

function applyState(s) {
  if (!s) return;
  restoring = true;
  STATE_FIELDS.forEach((id) => { if (s[id] != null) $(id).value = s[id]; });
  STATE_CHECKS.forEach((id) => { if (s[id] != null) $(id).checked = s[id] === "1"; });
  if (safeKey(s.sk)) { sortKey = s.sk; sortDir = Number(s.sd) === 1 ? 1 : -1; }
  if (safeKey(s.lk)) { loopSortKey = s.lk; loopSortDir = Number(s.ld) === 1 ? 1 : -1; }
  if (s.v === "routes" || s.v === "loops" || s.v === "enroute") view = s.v;
  applySortIndicators();
  syncToggles();
  restoring = false;
}

async function copyShareLink() {
  saveState();
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    const prev = btn.textContent;
    btn.textContent = "✓ Lien copié";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1500);
  } catch {
    // Presse-papiers indisponible (contexte non sécurisé) : on laisse l'URL dans la barre.
  }
}

// ---------- Édition inline d'une valeur corrigeable ----------
// Remplace le span par un champ ; à la validation, enregistre la correction et rafraîchit.
function startEdit(span) {
  if (span.querySelector("input")) return;
  const { c, t, s, f: field, v } = span.dataset;
  const inp = document.createElement("input");
  inp.type = "number"; inp.min = "0"; inp.value = v; inp.className = "editv-input";
  span.replaceChildren(inp);
  inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) setOverride(c, t, s, field, inp.value === "" ? null : inp.value);
    updateOvBadge();
    refresh(); // re-render la vue courante avec la valeur corrigée
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  inp.addEventListener("blur", () => commit(true));
}

// Met à jour le bouton « corrections » (compteur / visibilité).
function updateOvBadge() {
  const btn = $("resetOv");
  const n = ovCount();
  btn.hidden = n === 0;
  btn.textContent = `✎ ${n} correction${n > 1 ? "s" : ""} · réinitialiser`;
}

function resetAllOverrides() {
  if (!ovCount()) return;
  if (!confirm("Effacer toutes tes corrections locales de prix et de stock ?")) return;
  resetOverrides();
  updateOvBadge();
  refresh();
}

// Grise le champ soute/budget quand sa contrainte est désactivée.
function syncToggles() {
  const cargoOff = !$("useCargo").checked;
  const budgetOff = !$("useBudget").checked;
  $("cargo").disabled = cargoOff;
  $("ship").disabled = cargoOff;
  $("budget").disabled = budgetOff;
}

async function init() {
  setupSort();
  setupLoopSort();
  ["cargo", "budget", "search", "system", "freshness", "sameSystem", "noOutpost", "legalOnly", "capStock"].forEach((id) =>
    $(id).addEventListener("input", refresh)
  );
  ["useCargo", "useBudget"].forEach((id) =>
    $(id).addEventListener("change", () => {
      syncToggles();
      refresh();
    })
  );
  $("viewRoutes").addEventListener("click", () => switchView("routes"));
  $("viewLoops").addEventListener("click", () => switchView("loops"));
  $("viewEnroute").addEventListener("click", () => switchView("enroute"));
  $("share").addEventListener("click", copyShareLink);
  // Contrôles « En route ».
  $("origin").addEventListener("input", () => { resolveOrigin(); refresh(); });
  $("destSystem").addEventListener("input", refresh);
  // Manifeste : ajustement des SCU (recalcul à la volée) + ajout d'une commodité suggérée.
  $("manifest").addEventListener("input", (e) => {
    if (e.target.classList.contains("mqty-input")) updateManifestTotals();
  });
  $("manifest").addEventListener("click", (e) => {
    const add = e.target.closest(".suggest-add");
    if (add) addSuggestion(add.dataset.name);
  });
  // Corrections locales : clic (ou Entrée/Espace) sur une valeur éditable ; bouton reset.
  document.addEventListener("click", (e) => {
    const span = e.target.closest(".editv");
    if (span && !span.querySelector("input")) startEdit(span);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("editv")) {
      e.preventDefault();
      startEdit(e.target);
    }
  });
  $("resetOv").addEventListener("click", resetAllOverrides);
  loadOverrides();
  updateOvBadge();
  syncToggles();

  // État à restaurer (URL partagée en priorité, sinon dernière session locale).
  const saved = loadState();

  try {
    const [routes, loops, meta] = await Promise.all([
      fetch("data/routes.json").then((r) => r.json()),
      fetch("data/loops.json").then((r) => r.json()).catch(() => []),
      fetch("data/meta.json").then((r) => r.json()).catch(() => null),
      loadShips(),
    ]);
    ROUTES = routes;
    LOOPS = loops;

    // Remplit les filtres système (achat + vente) : #system et la destination « En route ».
    const systems = [...new Set(routes.flatMap((r) => [r.buy.system, r.sell.system]))].sort();
    const sel = $("system"), dest = $("destSystem");
    systems.forEach((s) => {
      sel.appendChild(new Option(s, s));
      dest.appendChild(new Option(s, s));
    });

    if (meta) {
      const d = new Date(meta.generated_at * 1000);
      $("meta").innerHTML =
        `<b>${meta.routes}</b> routes · <b>${meta.loops ?? LOOPS.length}</b> boucles · <b>${meta.commodities}</b> commodités<br>` +
        `Mis à jour le ${d.toLocaleString("fr-FR")}`;
    }
    // Applique l'état restauré une fois le menu système peuplé, puis affiche la bonne vue.
    applyState(saved);
    switchView(view);
  } catch (e) {
    $("meta").textContent = "Erreur de chargement des données.";
    $("empty").hidden = false;
    $("empty").textContent = "Impossible de charger data/routes.json — lance le script de mise à jour.";
    console.error(e);
  }
}

init();
