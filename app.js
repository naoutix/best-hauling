"use strict";

// Fonctions de calcul pures (testées par logic.test.mjs).
import {
  tripMinutes, ageDays, pairAge,
  normalizeScores, bySort, addableUnits, scuBoxes, bestChain,
  ovKey, effFromStore, setInStore, safeKey, encodeState, decodeState,
  routePasses, loopPasses,
  routeMetrics, loopMetrics, enRouteDeals, bestManifest, buildChainAdjacency,
  commoditySummaries, commodityPoints, compactValue,
  manifestTotals, freeAddUnits, manifestLine, stationLabel, parseStationLabel,
  legFromRoute, legsFromLoop, legsFromChain, startJourney, startJourneyAt, journeyStations, journeyEnd,
  journeyConnects, addToJourney, setJourneyPosition, currentLeg, journeyMargin,
  encodeJourney, decodeJourney,
} from "./logic.mjs";

// Libellé compact des caisses SCU standard, ex. « 8×32 · 1×16 · 1×4 · 1×2 · 1×1 ».
function scuBoxesLabel(n) {
  const boxes = scuBoxes(n);
  return boxes.length ? boxes.map((b) => `${b.count}×${b.size}`).join(" · ") : "";
}

// État global
let ROUTES = [];
let LOOPS = [];
let view = "routes"; // "routes" | "loops"
let sortKey = "score";
let sortDir = -1; // -1 = décroissant, 1 = croissant
let loopSortKey = "score";
let loopSortDir = -1;
// Lignes actuellement affichées (dans l'ordre du DOM) pour déplier le schéma de trajet.
let shownRoutes = [], shownEnroute = [], shownLoops = [];
// Vue « Commodités » : mode de tri (margin|code|kind|custom), clé/sens custom, sélection.
let commMode = "margin", commSortKey = "margin", commSortDir = -1, commSelected = null, shownCommodities = [];
let commMaxMargin = 0; // marge max de la liste courante (pour colorer la heatmap en relatif)
let commCarried = new Set(); // commodités transportées au moins 1 fois dans le voyage (highlight board)
// Compagnon de voyage : parcours sélectionné { legs[], current } ou null.
let JOURNEY = null;
// Affiche la carte du vaisseau correspondant au champ (défini par loadShips ; utilisé à la restauration).
let showShipCard = () => {};

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

// ---------- Fiabilité : fraîcheur, statut de stock, aberrations ----------
// (ageDays/pairAge et les calculs de temps/score viennent de logic.mjs)
// Petite pastille colorée « il y a Xj/Xh » selon l'âge.
function freshChip(updated) {
  const d = ageDays(updated);
  if (d == null) return '<span class="fresh f-old" title="Date de relevé inconnue">?</span>';
  let cls = "f-good", label;
  if (d < 1) { cls = "f-good"; label = d < 1 / 24 ? "<1 h" : Math.round(d * 24) + " h"; }
  else { label = Math.round(d) + " j"; cls = d < 3 ? "f-good" : d < 7 ? "f-ok" : "f-old"; }
  return `<span class="fresh ${cls}" title="Relevé UEX il y a ${label}">${label}</span>`;
}
// Version compacte (pastille seule) : indicateur de fraîcheur par matériau dans le compagnon.
function freshDot(updated) {
  const d = ageDays(updated);
  if (d == null) return '<span class="fresh-dot f-old" title="Fraîcheur des données inconnue"></span>';
  const label = d < 1 ? (d < 1 / 24 ? "moins d'1 h" : Math.round(d * 24) + " h") : Math.round(d) + " j";
  const cls = d < 3 ? "f-good" : d < 7 ? "f-ok" : "f-old";
  return `<span class="fresh-dot ${cls}" title="Relevé UEX il y a ${label}"></span>`;
}
// Fraîcheur d'une ligne de manifeste = le plus ancien des relevés achat/vente (ou l'un des deux).
function lineFreshUpdated(l) {
  const b = l.buyUpdated || 0, s = l.sellUpdated || 0;
  return b && s ? Math.min(b, s) : b || s || 0;
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

// Score composite (tri « intelligent ») : combine la valeur (profit/heure si borné,
// sinon marge) avec la fiabilité — fraîcheur × disponibilité. Le calcul vit dans
// rawScoreOf (logic.mjs) ; normalizeScores normalise ensuite la liste sur 0-100.

// ---------- Corrections locales (prix & stock) ----------
// L'utilisateur peut corriger un prix ou un volume (stock à l'achat / demande à la vente)
// quand le relevé UEX est faux. Stocké UNIQUEMENT en local (localStorage), jamais partagé
// ni dans l'URL. Clé : « commodité|terminal|side » (side = "buy" | "vol"… non : "buy"/"sell").
const OV_KEY = "best-hauling-overrides";
// { "Commodité|Terminal|buy": { price?, vol?, base }, ... }
// base = date UEX (updated) du point AU MOMENT de la correction : la correction vaut
// « contre cet export ». Elle n'est périmée que si UEX republie ce point plus récemment.
let OVERRIDES = {};
let supersededKeys = new Set(); // corrections périmées pendant le rendu courant (pour le flash)

const nowSec = () => Math.floor(Date.now() / 1000);

function loadOverrides() {
  try { OVERRIDES = JSON.parse(localStorage.getItem(OV_KEY)) || {}; } catch { OVERRIDES = {}; }
}
function saveOverrides() {
  try { localStorage.setItem(OV_KEY, JSON.stringify(OVERRIDES)); } catch {}
}
const ovCount = () => Object.keys(OVERRIDES).length; // ovKey vient de logic.mjs

// Renvoie prix/volume effectifs (corrigés si une correction locale existe) + drapeaux.
// « Intelligent » : si le relevé UEX du point (dataUpdated) est PLUS RÉCENT que celui
// contre lequel la correction a été faite (base), la correction est périmée -> on la
// supprime et on revient à la valeur UEX (comptée pour le flash de notification).
function effVals(commodity, terminal, side, price, vol, dataUpdated) {
  const k = ovKey(commodity, terminal, side);
  const r = effFromStore(OVERRIDES, k, price, vol, dataUpdated); // décision + suppression périmée (logic.mjs)
  if (r.stale) { saveOverrides(); supersededKeys.add(k); } // effets de bord app : persistance + flash
  return r;
}

// Enregistre (ou efface) une correction. field = "price"|"vol". value null/"" = efface ce champ.
// baseUpdated = date UEX du point corrigé (l'état de l'export au moment de la correction).
function setOverride(commodity, terminal, side, field, value, baseUpdated) {
  setInStore(OVERRIDES, ovKey(commodity, terminal, side), field, value, baseUpdated); // logic.mjs
  saveOverrides();
}
function resetOverrides() { OVERRIDES = {}; saveOverrides(); }

// Flash discret quand des corrections ont été périmées par une mise à jour UEX.
let toastTimer = null;
function showToast(msg) {
  let el = $("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4500);
}
function notifySuperseded() {
  if (!supersededKeys.size) return;
  const n = supersededKeys.size;
  supersededKeys = new Set();
  updateOvBadge();
  showToast(`✎ ${n} correction${n > 1 ? "s" : ""} périmée${n > 1 ? "s" : ""} par une mise à jour UEX`);
}

// Applique les corrections à une paire buy/sell et renvoie des copies patchées + marge/roi.
function applyOverrides(commodity, buy, sell) {
  const b = effVals(commodity, buy.terminal, "buy", buy.price, buy.stock, buy.updated);
  const s = effVals(commodity, sell.terminal, "sell", sell.price, sell.demand, sell.updated);
  const nb = { ...buy, price: b.price, stock: b.vol, ovPrice: b.oprice, ovVol: b.ovol };
  const ns = { ...sell, price: s.price, demand: s.vol, ovPrice: s.oprice, ovVol: s.ovol };
  const margin = ns.price - nb.price;
  const roi = nb.price > 0 ? Math.round((margin / nb.price) * 1000) / 10 : 0;
  return { buy: nb, sell: ns, margin, roi };
}

// Calcule les champs dérivés d'une route selon les entrées utilisateur : applique les corrections
// locales (impur, globales OVERRIDES) puis délègue le calcul pur à routeMetrics (logic.mjs).
function evaluate(r, f) {
  const { buy, sell, margin, roi } = applyOverrides(r.commodity, r.buy, r.sell);
  const metrics = routeMetrics({
    buyPrice: buy.price, buyStock: buy.stock, sellDemand: sell.demand, margin,
    distance: r.distance, sameSystem: r.same_system,
    buyUpdated: buy.updated, sellUpdated: sell.updated,
    demandKnown: sell.ovVol, // ovVol = demande corrigée par l'utilisateur = fiable
  }, f);
  return { ...r, buy, sell, margin, roi, buyPrice: buy.price, sellPrice: sell.price, ...metrics };
}

// Cellule visuelle du score : mini-barre + valeur.
function scoreCell(score) {
  const tier = score >= 70 ? "s-good" : score >= 40 ? "s-ok" : "s-low";
  return `<div class="score-cell"><span class="scorebar ${tier}"><i style="width:${score}%"></i></span><b>${score}</b></div>`;
}

// Valeur éditable (clic pour corriger localement). side = "buy"|"sell", field = "price"|"vol".
// updated = date UEX du point (mémorisée comme base de fraîcheur de la correction).
function editv(commodity, terminal, side, field, value, ov, updated) {
  return `<span class="editv${ov ? " ov" : ""}" data-c="${esc(commodity)}" data-t="${esc(terminal)}" data-s="${side}" data-f="${field}" data-v="${value}" data-u="${updated || 0}" role="button" tabindex="0" title="Clic pour corriger localement ce chiffre">${fmt(value)}${ov ? '<span class="ovmark" title="Corrigé localement">✎</span>' : ""}</span>`;
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

  let rows = ROUTES.filter((r) => routePasses(r, f)).map((r) => evaluate(r, f));

  normalizeScores(rows);
  rows.sort(bySort(sortKey, sortDir));

  shownRoutes = rows;
  $("rows").innerHTML = rows.map(routeRowHTML).join("");
  $("empty").hidden = rows.length > 0;
  notifySuperseded();
}

// Un « nœud » du schéma (système › planète › terminal), réutilisé départ/arrivée.
function schemaLeg(label, end) {
  const nodes = [`<span class="sys ${esc(end.system.toLowerCase())}">${esc(end.system)}</span>`];
  if (end.planet) nodes.push(`<span class="snode">${esc(end.planet)}</span>`);
  nodes.push(`<span class="snode term">${esc(end.terminal)}</span>${end.outpost ? outpostTag(true) : ""}`);
  return `<div class="schema-leg"><span class="schema-label">${label}</span><div class="schema-path">${nodes.join('<span class="sep">›</span>')}</div></div>`;
}

// Schéma d'un trajet simple : Départ (sys›planète›terminal) ⟶ Arrivée.
function routeSchemaHTML(r) {
  const info = `${r.same_system ? "même système" : "⚡ saut inter-système"} · ~${Math.round(r.minutes)} min${r.distance ? ` · ${fmt(r.distance)} u` : ""}`;
  return `<div class="schema">${schemaLeg("Départ", r.buy)}<div class="schema-arrow"><span class="al">⟶</span><span class="ai">${info}</span></div>${schemaLeg("Arrivée", r.sell)}</div>`;
}

// Schéma d'une boucle : A ⇄ B.
function loopSchemaHTML(l) {
  const info = `${l.cross ? "⚡ inter-système" : "même système"} · ~${Math.round(l.minutes)} min (A/R)`;
  return `<div class="schema">${schemaLeg("A", l.a)}<div class="schema-arrow"><span class="al">⇄</span><span class="ai">${info}</span></div>${schemaLeg("B", l.b)}</div>`;
}

// Ligne de tableau pour une route évaluée (partagée par « Trajets simples » et « En route »).
function routeRowHTML(r, i) {
  const cross = r.same_system ? "" : '<span class="cross">⚡ saut inter-système</span>';
  return `
      <tr data-row="${i}">
        <td class="loc">
          <div class="commodity-cell"><button class="route-toggle" data-row="${i}" title="Voir le trajet" aria-label="Voir le trajet">🗺</button><button class="journey-pick" data-row="${i}" title="Faire ce trajet — compagnon de voyage" aria-label="Sélectionner ce trajet">▶</button>${commodityIcon(r.kind)}<span class="cname">${esc(r.commodity)}</span></div>
          <div class="loc-badges">${illegalTag(r.illegal)}${suspectTag(r)}${cross}</div>
        </td>
        <td class="loc">
          <div class="term-name">${esc(r.buy.terminal)}</div>
          <div class="loc-badges">${sysBadge(r.buy.system)}${outpostTag(r.buy.outpost)}</div>
          <div class="loc-sub">${esc(r.buy.planet)} · ${editv(r.commodity, r.buy.terminal, "buy", "price", r.buy.price, r.buy.ovPrice, r.buy.updated)} aUEC · ${statusDot(r.buy.status, "buy")}<span class="stock" title="Stock disponible à l'achat (relevé UEX)">stock ${editv(r.commodity, r.buy.terminal, "buy", "vol", r.buy.stock, r.buy.ovVol, r.buy.updated)} SCU</span></div>
          <div class="loc-fresh">${freshChip(r.buy.updated)}</div>
        </td>
        <td class="loc">
          <div class="term-name">${esc(r.sell.terminal)}</div>
          <div class="loc-badges">${sysBadge(r.sell.system)}${outpostTag(r.sell.outpost)}</div>
          <div class="loc-sub">${esc(r.sell.planet)} · ${editv(r.commodity, r.sell.terminal, "sell", "price", r.sell.price, r.sell.ovPrice, r.sell.updated)} aUEC · ${statusDot(r.sell.status, "sell")}<span class="stock" title="Demande / stock à la vente (relevé UEX)">demande ${editv(r.commodity, r.sell.terminal, "sell", "vol", r.sell.demand, r.sell.ovVol, r.sell.updated)} SCU</span></div>
          <div class="loc-fresh">${freshChip(r.sell.updated)}</div>
        </td>
        <td>${scoreCell(r.score)}</td>
        <td class="num">${fmt(r.margin)}</td>
        <td class="num roi-badge">${r.roi}%</td>
        <td class="num"${r.units ? ` title="Caisses : ${scuBoxesLabel(r.units)}"` : ""}>${fmt(r.units)}</td>
        <td class="num">${fmt(r.investment)}</td>
        <td class="num profit">${fmt(r.profit)}</td>
        <td class="num profit" title="Estimation ${Math.round(r.minutes)} min/voyage">${fmt(r.profitHour)}</td>
      </tr>`;
}

// ---------- Vue "Boucles aller-retour" ----------
// Corrige un segment de boucle (achat au terminal `buyT`, vente au terminal `sellT`).
function effLeg(leg, buyT, sellT) {
  const b = effVals(leg.commodity, buyT, "buy", leg.buyPrice, leg.stock, leg.updated);
  const s = effVals(leg.commodity, sellT, "sell", leg.sellPrice, leg.demand, leg.updated);
  return { ...leg, buyPrice: b.price, stock: b.vol, sellPrice: s.price, demand: s.vol, demandKnown: s.ovol, margin: s.price - b.price };
}

function evaluateLoop(l, f) {
  const out = effLeg(l.out, l.a.terminal, l.b.terminal);
  const back = effLeg(l.back, l.b.terminal, l.a.terminal);
  const cross = l.a.system !== l.b.system;
  const metrics = loopMetrics(out, back, l.distance, cross, f); // calcul pur (logic.mjs)
  return { ...l, out, back, cross, ...metrics };
}

function renderLoops() {
  const f = readFilters();

  let rows = LOOPS.filter((l) => loopPasses(l, f)).map((l) => evaluateLoop(l, f));

  normalizeScores(rows);
  rows.sort(bySort(loopSortKey, loopSortDir));
  // Compagnon : remonte en tête (sans filtrer) les boucles qui partent de la FIN du parcours —
  // c'est le point d'extension (une boucle depuis là s'enchaîne au parcours). Cohérent avec addToJourney.
  const hereArrival = JOURNEY ? journeyEnd(JOURNEY)?.name : null;
  if (hereArrival) {
    rows.forEach((l) => { l._fromHere = l.a.terminal === hereArrival || l.b.terminal === hereArrival; });
    rows.sort((a, b) => (b._fromHere ? 1 : 0) - (a._fromHere ? 1 : 0)); // tri stable : pertinentes d'abord
  }
  shownLoops = rows;

  $("loopRows").innerHTML = rows
    .map(
      (l, i) => `
      <tr data-row="${i}"${l._fromHere ? ' class="from-here"' : ""}>
        <td class="loc loop-cell">
          <button class="route-toggle" data-row="${i}" title="Voir le trajet" aria-label="Voir le trajet">🗺</button>
          <button class="journey-pick" data-row="${i}" title="Ajouter cette boucle au voyage" aria-label="Ajouter au voyage">▶</button>
          <div class="loop-ends">
            <div class="loop-end"><span class="term-name">${esc(l.a.terminal)}</span>${sysBadge(l.a.system)}${outpostTag(l.a.outpost)}</div>
            <div class="loop-mid"><span class="loop-arrow">⇄</span>${l.cross ? '<span class="cross">⚡ inter-système</span>' : ""}</div>
            <div class="loop-end"><span class="term-name">${esc(l.b.terminal)}</span>${sysBadge(l.b.system)}${outpostTag(l.b.outpost)}</div>
            <div class="loc-fresh">${freshChip(l.out.updated && l.back.updated ? Math.min(l.out.updated, l.back.updated) : l.out.updated || l.back.updated || 0)}</div>
          </div>
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
  notifySuperseded();
}

// ---------- Mode « En route » (trajet dirigé) + manifeste multi-commodité ----------
let MARKET = null;            // graphe d'échange, chargé à la demande
let enrouteReady = false;     // datalist/destSystem peuplés une seule fois
let originMap = new Map();    // libellé « Nom — Système » -> index terminal (achat uniquement)
let stationMap = new Map();   // libellé -> index, TOUS les terminaux (pour la vue Corrections)
let enrouteOrigin = null;     // index du terminal de départ sélectionné
let stationSel = null;        // index de la station sélectionnée (vue Corrections)

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
      const label = stationLabel(t.name, t.system);
      originMap.set(label, b[0]);
      opts.push(label);
    }
  }));
  opts.sort((a, b) => a.localeCompare(b, "fr"));
  $("originList").innerHTML = opts.map((l) => `<option value="${esc(l)}"></option>`).join("");

  // Datalist de TOUTES les stations (achat ou vente) pour la vue Corrections.
  const stations = MARKET.terminals.map((t, i) => ({ label: stationLabel(t.name, t.system), i }));
  stations.forEach((s) => stationMap.set(s.label, s.i));
  stations.sort((a, b) => a.label.localeCompare(b.label, "fr"));
  $("stationList").innerHTML = stations.map((s) => `<option value="${esc(s.label)}"></option>`).join("");

  // Datalist de TOUTES les commodités (pour l'ajout libre au manifeste).
  $("commodityList").innerHTML = MARKET.commodities
    .map((c) => `<option value="${esc(c.name)}">${esc(c.code || "")}</option>`).join("");

  enrouteReady = true;
  resolveOrigin(); // au cas où une valeur a été restaurée
}

// Résout le terminal de départ depuis le texte du champ (libellé exact).
function resolveOrigin() {
  const v = $("origin").value.trim();
  enrouteOrigin = originMap.has(v) ? originMap.get(v) : null;
}

// Résout le terminal d'ARRIVÉE forcé (En route) depuis le champ (libellé exact), ou null.
let enrouteDest = null;
function resolveDest() {
  const v = $("destTerminal").value.trim();
  enrouteDest = stationMap.has(v) ? stationMap.get(v) : null;
}

// dealFrom / enRouteDeals / bestManifest / buildChainAdjacency vivent dans logic.mjs (fonctions
// pures) ; on leur passe MARKET et le résolveur de corrections effVals depuis les vues.

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
// m = contexte de manifeste { lines, cargo, f, originIdx, destIdx, origin, dest } ; par défaut
// celui d'« En route », mais une jambe de voyage passe le sien (cf. legSuggestCtx).
function manifestRemaining(m = currentManifest) {
  const { scu, invest } = manifestTotals(m.lines);
  const budgetLeft = m.f.useBudget && m.f.budget > 0 ? m.f.budget - invest : Infinity;
  return { scu, invest, cargoLeft: m.cargo - scu, budgetLeft };
}

// Commodités qui pourraient remplir l'espace libre (même origine -> même destination), non chargées.
function suggestionsFor(m = currentManifest) {
  const have = new Set(m.lines.map((l) => l.name));
  const out = [];
  MARKET.commodities.forEach((c) => {
    if (have.has(c.name) || (m.f.legalOnly && c.illegal)) return;
    const b = c.buys.find((x) => x[0] === m.originIdx);
    const s = c.sells.find((x) => x[0] === m.destIdx);
    if (!b || !s) return;
    const eb = effVals(c.name, m.origin.name, "buy", b[1], b[2], b[3]);
    const es = effVals(c.name, m.dest.name, "sell", s[1], s[2], s[3]);
    const margin = es.price - eb.price;
    if (margin <= 0) return;
    out.push({ name: c.name, kind: c.kind, illegal: c.illegal, buyPrice: eb.price, stock: eb.vol, sellPrice: es.price, demand: es.vol, demandKnown: es.ovol, margin, buyUpdated: b[3], sellUpdated: s[3] });
  });
  return out.sort((a, b) => b.margin - a.margin);
}

// addableUnits vient de logic.mjs.

// HTML des suggestions de remplissage pour un contexte de manifeste (En route ou jambe de voyage).
// `addAttrs` = attributs data-* posés sur le bouton d'ajout, propres à l'appelant.
function suggestionsHTML(m, addAttrs = "") {
  const rem = manifestRemaining(m);
  if (rem.cargoLeft <= 0) return "";
  const sugg = suggestionsFor(m).map((it) => ({ it, u: addableUnits(it, rem) })).filter((x) => x.u >= 1).slice(0, 6);
  if (!sugg.length) return `<div class="suggest-head">${fmt(rem.cargoLeft)} SCU libres — aucune autre commodité rentable vers cette destination.</div>`;
  return `<div class="suggest-head">Remplir les ${fmt(rem.cargoLeft)} SCU libres — suggestions :</div>` +
    sugg.map(({ it, u }) =>
      `<div class="sline">${commodityIcon(it.kind)}` +
      `<span class="mname">${esc(it.name)}${illegalTag(it.illegal)}</span>` +
      `<span class="mstock">stock ${fmt(it.stock)} · dem. ${fmt(it.demand)}</span>` +
      `<span class="mprice">${fmt(it.buyPrice)} → ${fmt(it.sellPrice)} · marge ${fmt(it.margin)}</span>` +
      `<button class="suggest-add" data-name="${esc(it.name)}"${addAttrs} title="Ajouter au manifeste">+ ${fmt(u)} SCU</button></div>`
    ).join("");
}

function renderSuggestions() {
  const box = $("manifestSuggest");
  if (!box || !currentManifest) return;
  box.innerHTML = suggestionsHTML(currentManifest);
}

function addSuggestion(name) {
  const it = suggestionsFor().find((x) => x.name === name);
  if (!it) return;
  const u = addableUnits(it, manifestRemaining());
  if (u <= 0) return;
  currentManifest.lines.push({ ...it, units: u, cap: u });
  paintManifest();
}

// Trouve une commodité par nom OU code (insensible à la casse/espaces). Partagé par les ajouts libres.
const findCommodity = (name) => {
  const q = (name || "").trim().toLowerCase();
  return q ? MARKET.commodities.find((x) => x.name.toLowerCase() === q || (x.code && x.code.toLowerCase() === q)) : null;
};

// Ajout LIBRE : n'importe quelle commodité (par nom ou code), même si elle n'est pas vendable à
// destination — on la charge pour l'écouler ailleurs (ligne « carry-only », marge nulle ici).
function addManifestCommodity(name) {
  const m = currentManifest;
  if (!m) return;
  const c = findCommodity(name);
  if (!c || m.lines.some((l) => l.name === c.name)) return; // inconnue ou déjà dans le manifeste
  const b = c.buys.find((x) => x[0] === m.originIdx);   // achat au terminal de départ (si dispo)
  const s = c.sells.find((x) => x[0] === m.destIdx);    // vente à destination (peut ne pas exister)
  const eb = b ? effVals(c.name, m.origin.name, "buy", b[1], b[2], b[3]) : null;
  const es = s ? effVals(c.name, m.dest.name, "sell", s[1], s[2], s[3]) : null;
  const u = freeAddUnits(eb ? eb.vol : Infinity, manifestRemaining().cargoLeft);
  m.lines.push(manifestLine(c, eb, es, b ? b[3] : 0, s ? s[3] : 0, u, u));
  paintManifest();
}

// Retire une ligne du manifeste (par nom de commodité).
function removeManifestLine(name) {
  const m = currentManifest;
  if (!m) return;
  m.lines = m.lines.filter((l) => l.name !== name);
  paintManifest();
}

// Dessine le manifeste courant : totaux + lignes (SCU/prix/stock éditables) + suggestions.
function paintManifest() {
  const m = currentManifest;
  const card = $("manifest");
  const { profit, invest, scu } = manifestTotals(m.lines);
  card.hidden = false;
  card.innerHTML =
    `<div class="manifest-head">
      <span class="manifest-title">◈ Manifeste — ${esc(m.origin.name)}${sysBadge(m.origin.system)} → ${esc(m.dest.name)}${sysBadge(m.dest.system)}${m.cross ? ' <span class="cross">⚡ inter-système</span>' : ""}</span>
      <span class="manifest-tot" id="manifestTot">${manifestTotalsHTML(profit, scu, m.cargo, invest, m.cross)}</span>
      <button id="copyManifest" class="copy-btn" title="Copier le plan de chargement">⧉ Copier</button>
    </div>
    <div class="manifest-lines">` +
    m.lines.map((l, i) => {
      const carry = l.sellPrice == null; // pas vendable à cette destination -> à écouler ailleurs
      const demCell = carry ? '<span class="muted">—</span>' : editv(l.name, m.dest.name, "sell", "vol", l.demand, isOv(l.name, m.dest.name, "sell", "vol"), l.sellUpdated);
      const sellCell = carry ? '<span class="carry-tag" title="Pas vendable à cette destination — à écouler ailleurs">vend ailleurs</span>' : editv(l.name, m.dest.name, "sell", "price", l.sellPrice, isOv(l.name, m.dest.name, "sell", "price"), l.sellUpdated);
      const profitCell = carry ? '<span class="mprofit muted">—</span>' : `<span class="mprofit profit">+${fmt(l.units * l.margin)}</span>`;
      return `<div class="mline${carry ? " carry" : ""}">${commodityIcon(l.kind)}` +
        `<span class="mqtywrap"><input type="number" class="mqty-input" min="0" value="${l.units}" data-i="${i}" data-margin="${l.margin}" data-buy="${l.buyPrice}" data-cap="${l.cap}" title="Ajuste librement — tu peux dépasser le stock UEX (vol de fret, relevé périmé…)" aria-label="SCU ${esc(l.name)}"><span class="munit">SCU</span></span>` +
        `<span class="mname">${esc(l.name)}${illegalTag(l.illegal)}<button class="mline-del" data-name="${esc(l.name)}" title="Retirer du manifeste" aria-label="Retirer">✕</button></span>` +
        `<span class="mstock">stock ${editv(l.name, m.origin.name, "buy", "vol", l.stock, isOv(l.name, m.origin.name, "buy", "vol"), l.buyUpdated)} · dem. ${demCell}</span>` +
        `<span class="mprice">${editv(l.name, m.origin.name, "buy", "price", l.buyPrice, isOv(l.name, m.origin.name, "buy", "price"), l.buyUpdated)} → ${sellCell}</span>` +
        profitCell +
        `<span class="mboxes" title="Caisses SCU standard à charger">📦 ${scuBoxesLabel(l.units)}</span></div>`;
    }).join("") +
    `</div>
    <div class="manifest-add">
      <input id="manifestAddInput" list="commodityList" placeholder="Ajouter n'importe quelle commodité (même non vendable ici)…" autocomplete="off" aria-label="Ajouter une commodité" />
      <button id="manifestAddBtn" type="button" class="copy-btn">+ Ajouter</button>
    </div>
    <div id="manifestSuggest" class="manifest-suggest"></div>`;
  renderSuggestions();
}

// Recalcule totaux + profit par ligne d'après les SCU saisis, et rafraîchit les suggestions.
function updateManifestTotals() {
  if (!currentManifest) return;
  document.querySelectorAll("#manifest .mqty-input").forEach((inp) => {
    const i = Number(inp.dataset.i);
    const cap = Number(inp.dataset.cap);
    let u = Math.floor(Number(inp.value));
    if (!Number.isFinite(u) || u < 0) u = 0;
    // Le dépassement du stock UEX est autorisé (vol de fret, relevé périmé…) : on ne plafonne
    // plus à `cap`, on le signale visuellement pour que ce soit un choix conscient.
    inp.classList.toggle("over-stock", u > cap);
    if (currentManifest.lines[i]) currentManifest.lines[i].units = u;
    const line = inp.closest(".mline");
    line.querySelector(".mprofit").textContent = "+" + fmt(u * Number(inp.dataset.margin));
    line.querySelector(".mboxes").textContent = "📦 " + scuBoxesLabel(u);
  });
  const { profit, invest, scu } = manifestTotals(currentManifest.lines); // unités déjà synchronisées ci-dessus
  $("manifestTot").innerHTML = manifestTotalsHTML(profit, scu, currentManifest.cargo, invest, currentManifest.cross);
  renderSuggestions();
}

// Copie le plan de chargement en texte (pour un 2e écran / des notes).
function copyManifest() {
  const m = currentManifest;
  if (!m) return;
  const { profit, invest, scu } = manifestTotals(m.lines);
  const rows = m.lines.map(
    (l) => `${fmt(l.units)} SCU  ${l.name}  @ ${fmt(l.buyPrice)} -> ${fmt(l.sellPrice)}  (+${fmt(l.units * l.margin)} aUEC)  [${scuBoxesLabel(l.units)}]`
  );
  const text = [
    `Manifeste — ${m.origin.name} (${m.origin.system}) -> ${m.dest.name} (${m.dest.system})`,
    ...rows,
    `Total : ${fmt(scu)}/${fmt(m.cargo)} SCU · profit ${fmt(profit)} aUEC · investissement ${fmt(invest)} aUEC`,
  ].join("\n");
  const btn = $("copyManifest");
  navigator.clipboard?.writeText(text).then(() => {
    if (!btn) return;
    btn.textContent = "✓ Copié";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "⧉ Copier"; btn.classList.remove("copied"); }, 1500);
  }).catch(() => {});
}

function renderManifest(origin, destSystem, f, destTerminal) {
  const card = $("manifest");
  currentManifest = null;
  if (enrouteOrigin == null) { card.hidden = true; return; }
  if (!f.useCargo || !(f.cargo > 0)) {
    card.hidden = false;
    card.innerHTML = `<div class="manifest-hint">Active la <b>soute (SCU)</b> pour calculer un manifeste de remplissage.</div>`;
    return;
  }
  const man = bestManifest(MARKET, origin, destSystem, f, effVals, destTerminal);
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
  resolveOrigin(); // re-résout depuis le champ (peut avoir été posé par le parcours, sans événement input)
  resolveDest();
  const f = readFilters();
  const emptyMsg = $("empty");

  renderManifest(enrouteOrigin, $("destSystem").value, f, enrouteDest);

  if (enrouteOrigin == null) {
    $("enrouteRows").innerHTML = "";
    emptyMsg.hidden = false;
    emptyMsg.textContent = "Choisis un terminal de départ pour voir le fret à emporter.";
    return;
  }

  const destSystem = $("destSystem").value;
  // sysFilter:"" — le système d'arrivée est filtré par destSystem (ou le terminal forcé), pas par le menu « système d'achat ».
  const ef = { ...f, sysFilter: "" };
  let deals = enRouteDeals(MARKET, enrouteOrigin, destSystem, enrouteDest)
    .filter((r) => routePasses(r, ef))
    .map((r) => evaluate(r, f));

  normalizeScores(deals);
  deals.sort(bySort(sortKey, sortDir));
  shownEnroute = deals;
  $("enrouteRows").innerHTML = deals.map(routeRowHTML).join("");
  emptyMsg.hidden = deals.length > 0;
  if (!deals.length) emptyMsg.textContent = "Aucun fret rentable depuis ce terminal avec ces filtres.";
  notifySuperseded();
}

// ---------- Vue « Chaîne » (multi-sauts A -> B -> C ...) ----------
let chainOrigin = null; // index du terminal de départ de la chaîne
let shownChain = null;  // chaîne actuellement affichée (pour l'ajout au voyage)

function resolveChainOrigin() {
  const v = $("chainOrigin").value.trim();
  chainOrigin = originMap.has(v) ? originMap.get(v) : null;
}

// buildChainAdjacency vit dans logic.mjs (fonction pure) ; appelée avec MARKET + effVals.

function chainCardHTML(chain) {
  const T = (idx) => MARKET.terminals[idx];
  const invest = chain.legs[0] ? chain.legs[0].units * chain.legs[0].buyPrice : 0;
  let minutes = 0;
  for (let i = 0; i < chain.legs.length; i++) {
    minutes += tripMinutes(0, T(chain.path[i]).system !== T(chain.path[i + 1]).system);
  }
  const nodes = chain.path
    .map((idx) => `<span class="snode term">${esc(T(idx).name)}</span>${sysBadge(T(idx).system)}`)
    .join('<span class="chain-arrow">→</span>');
  const legs = chain.legs
    .map((leg, i) => {
      const from = T(chain.path[i]).name, to = T(chain.path[i + 1]).name;
      return `<div class="chain-leg"><span class="chain-step">${i + 1}</span><div class="chain-leg-main">` +
        `<div class="commodity-cell">${commodityIcon(leg.kind)}<span><b>${esc(leg.commodity)}</b>${illegalTag(leg.illegal)} · ${fmt(leg.units)} SCU</span></div>` +
        `<div class="loc-sub">${esc(from)} → ${esc(to)} · ${fmt(leg.buyPrice)} → ${fmt(leg.sellPrice)} (marge ${fmt(leg.margin)}/SCU)</div>` +
        `</div><span class="chain-leg-profit profit">+${fmt(leg.profit)}</span></div>`;
    })
    .join("");
  return `<div class="chain">
      <div class="chain-head">
        <span class="chain-path">${nodes}</span>
        <span class="chain-tot">Profit <b class="profit">${fmt(chain.profit)}</b> aUEC · ${chain.legs.length} saut${chain.legs.length > 1 ? "s" : ""} · capital de départ ${fmt(invest)} · ~${Math.round(minutes)} min</span>
        <button id="chainToJourney" class="chain-pick" title="Ajouter cette chaîne au voyage en cours">▶ Ajouter au voyage</button>
      </div>
      <div class="chain-legs">${legs}</div>
    </div>`;
}

function renderChain() {
  if (!MARKET) { loadMarket().then(() => { setupEnRoute(); renderChain(); }); return; }
  if (!enrouteReady) setupEnRoute();
  resolveChainOrigin();
  const box = $("chainOut");
  const f = readFilters();
  shownChain = null;
  const hint = (msg) => { box.innerHTML = `<div class="manifest-hint">${msg}</div>`; notifySuperseded(); };
  if (chainOrigin == null) return hint("Choisis un <b>terminal de départ</b> pour calculer une chaîne rentable.");
  if (!f.useCargo || !(f.cargo > 0)) return hint("Active la <b>soute (SCU)</b> pour dimensionner la chaîne.");
  const hops = Number($("hops").value) || 3;
  const chain = bestChain(buildChainAdjacency(MARKET, f, effVals), chainOrigin, hops, { cargo: f.cargo });
  if (!chain || !chain.legs.length) return hint("Aucune chaîne rentable depuis ce terminal avec ces filtres.");
  shownChain = chain;
  box.innerHTML = chainCardHTML(chain);
  notifySuperseded();
}

// ---------- Compagnon de voyage : résumé du parcours (près du vaisseau) ----------
// Sélectionne un trajet/une boucle/une chaîne -> met à jour le parcours (étend si ça s'enchaîne).
function pickJourney(legs) {
  if (!legs || !legs.length) return;
  JOURNEY = addToJourney(JOURNEY, legs);
  syncViewsToJourney();
  renderJourney();
  refresh(); // reflète la nouvelle destination/origine dans la vue courante
}

// Pré-remplit les contrôles des vues d'après la POSITION COURANTE du parcours.
// « Pré-rempli » : on pose les défauts, l'utilisateur reste libre de les changer.
function syncViewsToJourney() {
  if (!JOURNEY) return;
  const here = journeyStations(JOURNEY)[JOURNEY.current]; // station où l'on se trouve
  if (!here) return;
  const originLabel = stationLabel(here.name, here.system);
  $("origin").value = originLabel;    // En route : départ = station courante
  $("chainOrigin").value = originLabel; // Chaîne : départ = station courante
  const leg = currentLeg(JOURNEY);
  if (leg) {
    $("destTerminal").value = stationLabel(leg.to, leg.toSystem); // arrivée forcée = jambe courante
    $("destSystem").value = "";
  } else {
    $("destTerminal").value = ""; // au bout du parcours : on cherche le fret onward, pas d'arrivée imposée
  }
}
function clearJourney() {
  JOURNEY = null;
  renderJourney();
  saveState();
}
// Ensemble des commodités transportées au moins une fois sur le parcours (union des manifestes).
function journeyCarriedCommodities() {
  const set = new Set();
  if (!JOURNEY || !MARKET) return set;
  const f = readFilters();
  JOURNEY.legs.forEach((leg) => legEffectiveLines(leg, f).forEach((l) => set.add(l.name)));
  return set;
}

// Manifeste optimal d'une jambe (from -> to) : remplissage multi-commodité, terminal d'arrivée forcé.
function legManifest(leg, f) {
  if (!MARKET || !stationMap.size) return null;
  const fromIdx = stationMap.get(stationLabel(leg.from, leg.fromSystem));
  const toIdx = stationMap.get(stationLabel(leg.to, leg.toSystem));
  if (fromIdx == null || toIdx == null) return null;
  return bestManifest(MARKET, fromIdx, "", f, effVals, toIdx); // { lines, profit, … } ou null
}

// ---------- Édition inline des manifestes de jambe (persistée en localStorage, HORS lien) ----------
// Clé de jambe = "from|to". Le PARCOURS (arrêts) va dans l'URL ; les édits restent locaux.
const JOURNEY_EDITS_KEY = "best-hauling-journey-edits";
let JOURNEY_EDITS = {};
let journeyExpandedLeg = -1; // index de la jambe dépliée en édition (-1 = aucune)
function loadJourneyEdits() { try { JOURNEY_EDITS = JSON.parse(localStorage.getItem(JOURNEY_EDITS_KEY)) || {}; } catch { JOURNEY_EDITS = {}; } }
function saveJourneyEdits() { try { localStorage.setItem(JOURNEY_EDITS_KEY, JSON.stringify(JOURNEY_EDITS)); } catch {} }
const legKey = (leg) => `${leg.from}|${leg.to}`;

// Manifeste EFFECTIF d'une jambe : version éditée si elle existe, sinon l'optimal calculé.
function legEffectiveLines(leg, f) {
  const k = legKey(leg);
  if (JOURNEY_EDITS[k]) return JOURNEY_EDITS[k];
  const man = legManifest(leg, f);
  return man ? man.lines : [];
}
// Copie l'optimal dans le store la 1re fois qu'on édite la jambe (puis on édite cette copie).
function materializeLeg(leg, f) {
  const k = legKey(leg);
  if (!JOURNEY_EDITS[k]) JOURNEY_EDITS[k] = (legManifest(leg, f)?.lines || []).map((l) => ({ ...l }));
  return JOURNEY_EDITS[k];
}
const legProfit = (lines) => manifestTotals(lines).profit;

// Contexte de manifeste d'une jambe, à la forme attendue par suggestionsFor/manifestRemaining
// (mêmes suggestions de remplissage qu'« En route »). null si le terminal ou la soute manque.
function legSuggestCtx(leg, lines, f) {
  if (!MARKET || !stationMap.size) return null;
  if (!f.useCargo || !(f.cargo > 0)) return null; // sans soute bornée, « SCU libres » n'a pas de sens
  const originIdx = stationMap.get(stationLabel(leg.from, leg.fromSystem));
  const destIdx = stationMap.get(stationLabel(leg.to, leg.toSystem));
  if (originIdx == null || destIdx == null) return null;
  return {
    lines, originIdx, destIdx,
    origin: { name: leg.from, system: leg.fromSystem },
    dest: { name: leg.to, system: leg.toSystem },
    cargo: f.cargo, f,
  };
}

// Actions d'édition d'une jambe (i = index de jambe).
function toggleLegEditor(i) { journeyExpandedLeg = journeyExpandedLeg === i ? -1 : i; renderJourney(); }
function editLegQty(i, li, val) {
  const lines = materializeLeg(JOURNEY.legs[i], readFilters());
  if (lines[li]) { let u = Math.floor(Number(val)); lines[li].units = Number.isFinite(u) && u > 0 ? u : 0; }
  saveJourneyEdits(); renderJourney();
}
// Saisie en direct : met à jour la ligne + repeint profit/caisses/suggestions SANS re-render global
// (un renderJourney() à chaque frappe ferait perdre le focus de l'input).
function liveLegQty(i, li, inp) {
  const leg = JOURNEY.legs[i];
  const lines = materializeLeg(leg, readFilters());
  const l = lines[li];
  if (!l) return;
  let u = Math.floor(Number(inp.value));
  if (!Number.isFinite(u) || u < 0) u = 0;
  l.units = u;
  inp.classList.toggle("over-stock", isFinite(l.cap) && u > l.cap);
  const row = inp.closest(".jman-line");
  const prof = row && row.querySelector(".jman-profit");
  if (prof) prof.textContent = l.sellPrice == null ? "—" : "+" + fmt(u * (l.margin || 0));
  renderLegSuggestions(i, lines);
}
// Repeint la boîte de suggestions d'une jambe dépliée.
function renderLegSuggestions(i, lines) {
  const box = document.querySelector(`.jman-suggest[data-leg="${i}"]`);
  if (!box) return;
  const ctx = legSuggestCtx(JOURNEY.legs[i], lines, readFilters());
  box.innerHTML = ctx ? suggestionsHTML(ctx, ` data-leg="${i}"`) : "";
}
// Ajoute une commodité suggérée à une jambe, remplie au max possible.
function addLegSuggestion(i, name) {
  const leg = JOURNEY.legs[i];
  const f = readFilters();
  const lines = materializeLeg(leg, f);
  const ctx = legSuggestCtx(leg, lines, f);
  if (!ctx) return;
  const it = suggestionsFor(ctx).find((x) => x.name === name);
  if (!it) return;
  const u = addableUnits(it, manifestRemaining(ctx));
  if (u <= 0) return;
  lines.push({ ...it, units: u, cap: u });
  saveJourneyEdits(); renderJourney();
}
function delLegLine(i, name) {
  const leg = JOURNEY.legs[i];
  JOURNEY_EDITS[legKey(leg)] = materializeLeg(leg, readFilters()).filter((l) => l.name !== name);
  saveJourneyEdits(); renderJourney();
}
function resetLeg(i) { delete JOURNEY_EDITS[legKey(JOURNEY.legs[i])]; saveJourneyEdits(); renderJourney(); }
// Ajout LIBRE d'une commodité à une jambe (même non vendable à l'arrivée -> ligne « carry-only »).
// Même comportement qu'« En route » (cf. addManifestCommodity) : remplit l'espace libre, ≥ 1 SCU.
function addLegLine(i, name) {
  const leg = JOURNEY.legs[i];
  const c = findCommodity(name);
  if (!c) return;
  const f = readFilters();
  const lines = materializeLeg(leg, f);
  if (lines.some((l) => l.name === c.name)) return;
  const fromIdx = stationMap.get(stationLabel(leg.from, leg.fromSystem)), toIdx = stationMap.get(stationLabel(leg.to, leg.toSystem));
  const b = c.buys.find((x) => x[0] === fromIdx), s = c.sells.find((x) => x[0] === toIdx);
  const eb = b ? effVals(c.name, leg.from, "buy", b[1], b[2], b[3]) : null;
  const es = s ? effVals(c.name, leg.to, "sell", s[1], s[2], s[3]) : null;
  const ctx = legSuggestCtx(leg, lines, f); // null si soute non bornée -> freeAddUnits met 1 SCU
  const u = freeAddUnits(eb ? eb.vol : Infinity, ctx ? manifestRemaining(ctx).cargoLeft : NaN);
  lines.push(manifestLine(c, eb, es, b ? b[3] : 0, s ? s[3] : 0, u, u));
  saveJourneyEdits(); renderJourney();
}

// Index du terminal de FIN de parcours (point d'extension), ou null.
function journeyEndIndex() {
  const end = journeyEnd(JOURNEY);
  return end && stationMap.size ? stationMap.get(stationLabel(end.name, end.system)) : null;
}
// Meilleure jambe (commodité de marge max) entre deux terminaux, ou null si aucun fret rentable.
function bestLegTo(fromIdx, toIdx) {
  if (fromIdx == null || toIdx == null) return null;
  const deals = enRouteDeals(MARKET, fromIdx, "", toIdx); // meilleure vente vers toIdx par commodité
  if (!deals.length) return null;
  return legFromRoute(deals.reduce((a, b) => (b.margin > a.margin ? b : a)));
}
// Jambe « à vide » (aucune commodité) entre deux terminaux — pour ajouter un arrêt même sans fret rentable.
function emptyLeg(fromIdx, toIdx) {
  if (fromIdx == null || toIdx == null) return null;
  const ft = MARKET.terminals[fromIdx], tt = MARKET.terminals[toIdx];
  return { from: ft.name, fromSystem: ft.system, to: tt.name, toSystem: tt.system, commodity: "", buyPrice: 0, sellPrice: 0, margin: 0 };
}
// Résout un terminal depuis le texte : libellé exact « Nom — Système », sinon par nom seul.
function resolveStationLabel(input) {
  const v = (input || "").trim();
  if (!v) return null;
  if (stationMap.has(v)) return stationMap.get(v);
  const lc = v.toLowerCase();
  for (const [label, idx] of stationMap) if (parseStationLabel(label).name.toLowerCase() === lc) return idx;
  return null;
}
// Suggestions d'arrêts : meilleures destinations rentables depuis la fin du parcours (top 4).
function journeyStopSuggestions() {
  const fromIdx = journeyEndIndex();
  if (fromIdx == null) return [];
  const byDest = new Map();
  enRouteDeals(MARKET, fromIdx, "").forEach((d) => {
    const label = stationLabel(d.sell.terminal, d.sell.system);
    const cur = byDest.get(label);
    if (!cur || d.margin > cur.margin) byDest.set(label, { label, terminal: d.sell.terminal, commodity: d.commodity, margin: d.margin });
  });
  return [...byDest.values()].sort((a, b) => b.margin - a.margin).slice(0, 4);
}
// Ajoute un arrêt (terminal) : nouvelle jambe optimale depuis la fin du parcours -> étend.
function addStopByTerminal(label) {
  const fromIdx = journeyEndIndex();
  const toIdx = resolveStationLabel(label);
  if (fromIdx == null || toIdx == null) return; // terminal inconnu / parcours vide
  // Jambe optimale s'il y a du fret rentable, sinon jambe « à vide » (on l'ajoute quand même).
  pickJourney([bestLegTo(fromIdx, toIdx) || emptyLeg(fromIdx, toIdx)]);
}

// Démarre un voyage « de zéro » depuis un terminal de départ (sans passer par un trajet ▶).
// On pose juste le point de départ ; l'utilisateur construit ensuite avec « + Arrêt ».
function beginJourney(label) {
  const v = (label || "").trim();
  if (!v) return;
  if (!stationMap.size) { loadMarket().then(() => { setupEnRoute(); beginJourney(v); }); return; } // marché requis pour résoudre
  const startIdx = resolveStationLabel(v);
  if (startIdx == null) return; // terminal inconnu
  const t = MARKET.terminals[startIdx];
  JOURNEY = startJourneyAt({ name: t.name, system: t.system });
  syncViewsToJourney();
  renderJourney();
  refresh();
}

// Retire un arrêt (index de station) et RECONNECTE les voisins (recalcule la jambe A->C).
function removeJourneyStop(stopIndex) {
  if (!JOURNEY) return;
  const legs = JOURNEY.legs;
  let newLegs;
  if (stopIndex <= 0) newLegs = legs.slice(1);                 // 1er arrêt -> retire la 1re jambe
  else if (stopIndex >= legs.length) newLegs = legs.slice(0, -1); // dernier arrêt -> retire la dernière jambe
  else {
    // arrêt du milieu : reconnecte stops[i-1] -> stops[i+1].
    const prev = legs[stopIndex - 1], next = legs[stopIndex];
    const fromIdx = stationMap.get(stationLabel(prev.from, prev.fromSystem));
    const toIdx = stationMap.get(stationLabel(next.to, next.toSystem));
    const bridge = bestLegTo(fromIdx, toIdx) || // si aucun fret rentable A->C, jambe « à vide » (contiguïté préservée)
      { from: prev.from, fromSystem: prev.fromSystem, to: next.to, toSystem: next.toSystem, commodity: "", buyPrice: 0, sellPrice: 0, margin: 0 };
    newLegs = [...legs.slice(0, stopIndex - 1), bridge, ...legs.slice(stopIndex + 1)];
  }
  if (!newLegs.length) { clearJourney(); return; }
  JOURNEY = { legs: newLegs, current: Math.min(JOURNEY.current, newLegs.length) };
  syncViewsToJourney();
  renderJourney();
  refresh();
}

function renderJourney() {
  const card = $("journeyCard");
  if (!card) return;
  // Aucun voyage -> invite à en démarrer un : depuis un trajet (▶) OU « de zéro » (point de départ).
  if (!JOURNEY) {
    card.hidden = false;
    const recap0 = $("journeyRecap"); if (recap0) recap0.hidden = true; // pas de récap sans voyage
    const row0 = $("shipJourneyRow"); if (row0) row0.classList.remove("stacked");
    card.innerHTML =
      `<div class="journey-head"><span class="journey-title">◈ Nouveau voyage</span></div>
       <p class="journey-hint">Choisis un trajet (▶) dans une vue, ou démarre de zéro :</p>
       <div class="journey-add">
         <input id="journeyStart" list="stationList" placeholder="Point de départ (terminal)…" autocomplete="off" aria-label="Point de départ du voyage" />
         <button id="journeyStartBtn" type="button" class="chain-pick">Commencer</button>
       </div>`;
    return;
  }
  card.hidden = false;
  // MARKET nécessaire pour les manifestes par jambe -> charge à la demande puis re-render.
  if (!MARKET) { loadMarket().then(() => { setupEnRoute(); renderJourney(); }); }
  else if (!enrouteReady) setupEnRoute();

  const stations = journeyStations(JOURNEY);
  const path = stations
    .map((s, i) => `<span class="jstep-wrap"><button class="jstep${i === JOURNEY.current ? " here" : ""}" data-i="${i}" title="Je suis ici"><span class="sys ${esc(s.system.toLowerCase())}">${esc(s.name)}</span></button><button class="jstep-del" data-i="${i}" title="Retirer cet arrêt" aria-label="Retirer">✕</button></span>`)
    .join('<span class="jsep">→</span>');
  const n = JOURNEY.legs.length;
  const f = readFilters();
  let totalProfit = 0, totalScu = 0; // récap : profit réel (aUEC) et SCU transportés sur tout le voyage
  // Manifeste (cargaison) de chaque jambe — optimal ou édité ; jambe dépliable pour l'éditer.
  const legsHtml = JOURNEY.legs.map((leg, i) => {
    const lines = MARKET ? legEffectiveLines(leg, f) : null;
    const edited = MARKET && !!JOURNEY_EDITS[legKey(leg)];
    const expanded = i === journeyExpandedLeg;
    let cargo, total;
    if (!MARKET) { cargo = '<span class="muted">calcul…</span>'; total = "—"; }
    else if (!lines.length) { cargo = '<span class="muted">aucun fret rentable</span>'; total = "0"; }
    else {
      cargo = lines.map((l) => `<span class="jcargo-item">${freshDot(lineFreshUpdated(l))}${commodityIcon(l.kind)}<span>${esc(l.name)}${illegalTag(l.illegal)}</span> <b>${fmt(l.units)} SCU</b></span>`).join("");
      total = fmt(legProfit(lines));
      totalProfit += legProfit(lines);
      totalScu += lines.reduce((s, l) => s + l.units, 0);
    }
    let editor = "";
    if (expanded && MARKET) {
      const rows = lines.map((l, li) =>
        `<div class="jman-line">${commodityIcon(l.kind)}` +
        `<span class="mqtywrap"><input type="number" class="jman-qty" min="0" value="${l.units}" data-leg="${i}" data-i="${li}" aria-label="SCU ${esc(l.name)}"><span class="munit">SCU</span></span>` +
        `<span class="jman-name">${freshDot(lineFreshUpdated(l))}${esc(l.name)}${illegalTag(l.illegal)}${l.sellPrice == null ? ' <span class="carry-tag">vend ailleurs</span>' : ""}</span>` +
        `<span class="jman-profit profit">${l.sellPrice == null ? "—" : "+" + fmt(l.units * (l.margin || 0))}</span>` +
        `<button class="jman-del" data-leg="${i}" data-name="${esc(l.name)}" title="Retirer">✕</button></div>`
      ).join("") || '<div class="muted jman-empty">Aucune commodité.</div>';
      const sctx = legSuggestCtx(leg, lines, f);
      editor = `<div class="jman">${rows}
        <div class="jman-add"><input class="jman-add-input" list="commodityList" data-leg="${i}" placeholder="+ commodité (même non vendable)…" autocomplete="off"><button class="jman-add-btn" data-leg="${i}">+</button>${edited ? `<button class="jman-reset" data-leg="${i}" title="Revenir au manifeste optimal">↺ optimal</button>` : ""}</div>
        <div class="jman-suggest manifest-suggest" data-leg="${i}">${sctx ? suggestionsHTML(sctx, ` data-leg="${i}"`) : ""}</div>
      </div>`;
    }
    return `<div class="jleg${i === JOURNEY.current ? " current" : ""}${expanded ? " expanded" : ""}">
        <div class="jleg-head" data-leg="${i}" role="button" tabindex="0" title="Éditer le manifeste de cette jambe"><span class="jleg-n">${i + 1}</span><span class="jleg-route">${esc(leg.from)} → ${esc(leg.to)}</span>${edited ? '<span class="jleg-edited" title="Manifeste personnalisé">✎</span>' : ""}<span class="jleg-profit profit">+${total}</span><span class="jleg-caret">${expanded ? "▾" : "▸"}</span></div>
        <div class="jleg-cargo">${cargo}</div>
        ${editor}
      </div>`;
  }).join("");

  // Ajout d'arrêt : champ libre (tous terminaux) + suggestions rentables depuis la fin.
  const sugList = MARKET ? journeyStopSuggestions() : [];
  const suggestBlock = !MARKET ? ""
    : sugList.length
      ? `<div class="journey-suggest"><span class="suggest-lbl">Suggestions :</span>${sugList.map((s) => `<button class="jstop-suggest" data-label="${esc(s.label)}" title="Ajouter ${esc(s.terminal)} — via ${esc(s.commodity)}, +${fmt(s.margin)} marge/SCU">+ ${esc(s.terminal)} <span class="muted">+${fmt(s.margin)}</span></button>`).join("")}</div>`
      : '<div class="journey-suggest-empty muted">Aucune destination rentable depuis ici — ajoute quand même un arrêt au champ ci-dessus (il aura un manifeste vide, à remplir à la main).</div>';
  const startHint = n === 0 ? '<p class="journey-hint">Départ posé — ajoute un arrêt pour construire ton parcours.</p>' : "";
  card.innerHTML =
    `<div class="journey-head"><span class="journey-title">◈ ${n === 0 ? "Voyage" : "Voyage en cours"}</span><button id="journeyClear" class="journey-clear" title="Effacer le parcours" aria-label="Effacer">✕</button></div>
     <div class="journey-path">${path}</div>
     ${startHint}
     <div class="journey-legs">${legsHtml}</div>
     <div class="journey-add">
       <input id="journeyAddStop" list="stationList" placeholder="+ Ajouter un arrêt (terminal)…" autocomplete="off" aria-label="Ajouter un arrêt" />
       <button id="journeyAddBtn" type="button" class="chain-pick">+ Arrêt</button>
     </div>
     ${suggestBlock}
     <div class="journey-meta">${n} saut${n > 1 ? "s" : ""} · marge cumulée <b class="profit">${fmt(journeyMargin(JOURNEY))}</b> aUEC/SCU</div>`;

  renderJourneyRecap({ n, totalProfit, totalScu, systems: new Set(stations.map((s) => s.system)).size });
}

// Récap du voyage (colonne de gauche, sous le vaisseau) : remplit l'espace avec des KPIs utiles.
function renderJourneyRecap({ n, totalProfit, totalScu, systems }) {
  const recap = $("journeyRecap");
  if (!recap) return;
  recap.hidden = false;
  const materials = MARKET ? journeyCarriedCommodities().size : 0;
  const kpi = (v, lbl) => `<div class="recap-kpi"><b>${v}</b><span>${lbl}</span></div>`;
  recap.innerHTML =
    `<div class="recap-head">◈ Résumé du voyage</div>
     <div class="recap-profit">${MARKET ? "+" + fmt(totalProfit) : "…"} <span>aUEC</span></div>
     <div class="recap-kpis">
       ${kpi(n, "saut" + (n > 1 ? "s" : ""))}
       ${kpi(MARKET ? fmt(totalScu) : "…", "SCU")}
       ${kpi(systems, "système" + (systems > 1 ? "s" : ""))}
       ${kpi(MARKET ? materials : "…", "matériau" + (materials > 1 ? "x" : ""))}
     </div>`;
  // Bascule intelligente : si la carte Voyage est bien plus haute que la colonne de gauche
  // (voyage long / jambe dépliée), on empile en pleine largeur pour supprimer le grand vide.
  // Mesure synchrone (getBoundingClientRect force le reflow) -> fiable même onglet non peint.
  const row = $("shipJourneyRow"), jc = $("journeyCard"), vl = $("voyageLeft");
  if (row && jc && vl && !jc.hidden) {
    row.classList.remove("stacked"); // mesure toujours dans la disposition côte-à-côte de base
    if (jc.getBoundingClientRect().height > vl.getBoundingClientRect().height + 140) row.classList.add("stacked");
  }
}

// Bascule entre les vues et rafraîchit la bonne.
function refresh() {
  if (view === "loops") renderLoops();
  else if (view === "enroute") renderEnRoute();
  else if (view === "chain") renderChain();
  else if (view === "corrections") renderCorrections();
  else if (view === "commodities") renderCommodities();
  else render();
  saveState();
}
function switchView(v) {
  view = v;
  $("viewRoutes").classList.toggle("active", v === "routes");
  $("viewLoops").classList.toggle("active", v === "loops");
  $("viewEnroute").classList.toggle("active", v === "enroute");
  $("viewChain").classList.toggle("active", v === "chain");
  $("viewCorrections").classList.toggle("active", v === "corrections");
  $("viewCommodities").classList.toggle("active", v === "commodities");
  $("routes").hidden = v !== "routes";
  $("loops").hidden = v !== "loops";
  $("enroute").hidden = v !== "enroute";
  $("enrouteControls").hidden = v !== "enroute";
  $("chainControls").hidden = v !== "chain";
  $("chainOut").hidden = v !== "chain";
  $("correctionsControls").hidden = v !== "corrections";
  $("corrections").hidden = v !== "corrections";
  $("commoditiesControls").hidden = v !== "commodities";
  $("commodities").hidden = v !== "commodities";
  if (v !== "enroute") $("manifest").hidden = true;
  if (v === "chain" || v === "corrections" || v === "commodities") $("empty").hidden = true;
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

  // Affiche la carte du vaisseau déjà présent dans le champ (ex. après restauration d'état).
  showShipCard = () => {
    const s = ships.find((x) => x.name.toLowerCase() === input.value.trim().toLowerCase());
    if (s) showCard(s);
  };

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
const STATE_FIELDS = ["cargo", "budget", "search", "system", "freshness", "ship", "origin", "destSystem", "destTerminal", "chainOrigin", "hops", "station"];
const STATE_CHECKS = ["useCargo", "useBudget", "sameSystem", "noOutpost", "legalOnly", "capStock"];
// safeKey / encodeState / decodeState viennent de logic.mjs.

let restoring = false; // évite de resauver pendant qu'on applique un état

function collectState() {
  const s = { v: view, sk: sortKey, sd: sortDir, lk: loopSortKey, ld: loopSortDir };
  STATE_FIELDS.forEach((id) => (s[id] = $(id).value));
  STATE_CHECKS.forEach((id) => (s[id] = $(id).checked ? 1 : 0));
  if (JOURNEY) s.j = encodeJourney(JOURNEY); // compagnon de voyage (partageable)
  return s;
}

function saveState() {
  if (restoring) return;
  const str = encodeState(collectState());
  try { localStorage.setItem(STATE_KEY, str); } catch {}
  history.replaceState(null, "", str ? "#" + str : location.pathname + location.search);
}

function loadState() {
  let str = location.hash.replace(/^#/, "");
  if (!str) { try { str = localStorage.getItem(STATE_KEY) || ""; } catch {} }
  return decodeState(str);
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
  if (["routes", "loops", "enroute", "chain", "corrections", "commodities"].includes(s.v)) view = s.v;
  if (s.j) JOURNEY = decodeJourney(s.j); // compagnon de voyage restauré (les champs sont déjà repris ci-dessus)
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
  const { c, t, s, f: field, v, u } = span.dataset;
  const inp = document.createElement("input");
  inp.type = "number"; inp.min = "0"; inp.value = v; inp.className = "editv-input";
  span.replaceChildren(inp);
  inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) setOverride(c, t, s, field, inp.value === "" ? null : inp.value, Number(u));
    updateOvBadge();
    refresh(); // re-render la vue courante avec la valeur corrigée
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  inp.addEventListener("blur", () => commit(true));
}

// Met à jour le libellé du bouton de vue « Corrections » (compteur).
function updateOvBadge() {
  const n = ovCount();
  $("viewCorrections").textContent = n ? `✎ Corrections (${n})` : "✎ Corrections";
}

function resetAllOverrides() {
  if (!ovCount()) return;
  if (!confirm("Effacer toutes tes corrections locales de prix et de stock ?")) return;
  resetOverrides();
  updateOvBadge();
  refresh();
}

// ---------- Vue « Corrections » : liste + édition par station ----------
function resolveStation() {
  const v = $("station").value.trim();
  stationSel = stationMap.has(v) ? stationMap.get(v) : null;
}

// Tableau éditable des commodités d'une station (prix/stock à l'achat, prix/demande à la vente).
function stationTableHTML(S, q) {
  const t = MARKET.terminals[S];
  const rows = [];
  MARKET.commodities.forEach((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return;
    const b = c.buys.find((x) => x[0] === S);
    const s = c.sells.find((x) => x[0] === S);
    if (!b && !s) return;
    const buyCell = b
      ? (() => { const e = effVals(c.name, t.name, "buy", b[1], b[2], b[3]); return `${editv(c.name, t.name, "buy", "price", e.price, e.oprice, b[3])} aUEC · stock ${editv(c.name, t.name, "buy", "vol", e.vol, e.ovol, b[3])}`; })()
      : '<span class="muted">—</span>';
    const sellCell = s
      ? (() => { const e = effVals(c.name, t.name, "sell", s[1], s[2], s[3]); return `${editv(c.name, t.name, "sell", "price", e.price, e.oprice, s[3])} aUEC · dem. ${editv(c.name, t.name, "sell", "vol", e.vol, e.ovol, s[3])}`; })()
      : '<span class="muted">—</span>';
    rows.push(`<tr><td class="loc"><div class="commodity-cell">${commodityIcon(c.kind)}<span>${esc(c.name)}${illegalTag(c.illegal)}</span></div></td><td>${buyCell}</td><td>${sellCell}</td></tr>`);
  });
  if (!rows.length) return `<p class="empty">Aucune commodité ${q ? "correspondante " : ""}à ${esc(t.name)}.</p>`;
  return `<div class="station-title">◈ ${esc(t.name)}${sysBadge(t.system)} — clique un chiffre pour le corriger localement</div>
    <table class="station-table"><thead><tr><th>Commodité</th><th>Achat (prix · stock)</th><th>Vente (prix · demande)</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

// Liste de toutes les corrections locales, avec suppression individuelle.
function correctionsListHTML() {
  const keys = Object.keys(OVERRIDES);
  if (!keys.length) return '<p class="empty">Aucune correction locale pour l\'instant. Cherche une station ci-dessus pour en créer.</p>';
  const sideLabel = (s) => (s === "buy" ? "achat" : "vente");
  const items = keys.sort().map((k) => {
    const o = OVERRIDES[k];
    const [commodity, terminal, side] = k.split("|");
    const parts = [];
    if (o.price != null) parts.push(`prix <b>${fmt(o.price)}</b>`);
    if (o.vol != null) parts.push(`${side === "buy" ? "stock" : "demande"} <b>${fmt(o.vol)}</b>`);
    return `<div class="corr-item"><div><b>${esc(commodity)}</b> · ${esc(terminal)} <span class="corr-side">${sideLabel(side)}</span><div class="loc-sub">${parts.join(" · ")}</div></div><button class="corr-del" data-key="${esc(k)}" title="Supprimer cette correction">✕</button></div>`;
  }).join("");
  return `<div class="corr-list-head"><span>${keys.length} correction${keys.length > 1 ? "s" : ""}</span><button id="resetAll" class="reset-ov">Tout réinitialiser</button></div>${items}`;
}

function renderCorrections() {
  if (!MARKET) { loadMarket().then(() => { setupEnRoute(); renderCorrections(); }); return; }
  if (!enrouteReady) setupEnRoute();
  resolveStation();
  const q = $("search").value.trim().toLowerCase();
  const station = stationSel != null ? stationTableHTML(stationSel, q) : '<p class="manifest-hint">Cherche une station ci-dessus pour voir et corriger ses prix et stocks.</p>';
  $("correctionsStation").innerHTML = station;
  $("correctionsList").innerHTML = correctionsListHTML();
  notifySuperseded();
}

// ---------- Vue « Commodités » : grand tableau + tous les points d'achat/vente ----------
// Tri du tableau : 3 modes prédéfinis (boutons) + tri par colonne (clic en-tête).
function sortCommodities(rows) {
  if (commMode === "margin") return rows.sort(bySort("margin", -1));                 // plus lucratif d'abord
  if (commMode === "code") return rows.sort(bySort("code", 1));                       // code A→Z
  if (commMode === "kind")                                                            // catégorie puis marge
    return rows.sort((a, b) => (a.kind || "").localeCompare(b.kind || "", "fr") || (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
  return rows.sort(bySort(commSortKey, commSortDir));                                 // colonne (mode custom)
}

// Applique un tri (bouton mode ou clic en-tête) et re-rend.
function setCommSort(key) {
  if (key === "margin" || key === "code" || key === "kind") {
    commMode = key;
  } else {
    if (commMode === "custom" && commSortKey === key) commSortDir *= -1;
    else { commSortKey = key; commSortDir = key === "bestBuy" || key === "name" || key === "code" ? 1 : -1; }
    commMode = "custom";
  }
  renderCommodities();
  saveState();
}

// Palier de couleur d'une tuile, RELATIF à la meilleure marge de la liste (heatmap :
// rouge = tête de peloton → bleu correct → gris atone → sans marge). S'adapte aux données.
function marginTier(m) {
  if (m == null || m <= 0) return "t-none";
  const r = commMaxMargin > 0 ? m / commMaxMargin : 0;
  if (r >= 0.66) return "t-hot";
  if (r >= 0.40) return "t-warm";
  if (r >= 0.18) return "t-mid";
  return "t-low";
}

// Une tuile du board : code UEX + marge max compacte (K/M), colorée par palier.
function commodityTileHTML(c) {
  const carried = commCarried.has(c.name);
  const cls = [
    "comm-tile", marginTier(c.margin),
    c.name === commSelected ? "selected" : "",
    c.illegal ? "illegal" : "",
    carried ? "carried" : "",
  ].filter(Boolean).join(" ");
  const title = `${c.name}${c.illegal ? " (illégal)" : ""}${carried ? " — transportée dans ton voyage" : ""} — marge max ${fmt(c.margin)} aUEC/SCU · ${c.nBuy} achat(s) / ${c.nSell} vente(s)`;
  return `<button class="${cls}" data-name="${esc(c.name)}" title="${esc(title)}">
      <span class="tile-code">${carried ? '<span class="tile-carried" title="Dans ton voyage">◆</span>' : ""}${esc(c.code || c.name.slice(0, 4).toUpperCase())}</span>
      <span class="tile-val">${c.margin == null ? "—" : compactValue(c.margin)}</span>
    </button>`;
}

// Détail d'une commodité : tous ses points d'achat (moins cher d'abord) et de vente (mieux payé d'abord).
function paintCommodityDetail() {
  const box = $("commDetail");
  if (!commSelected) { box.innerHTML = '<p class="manifest-hint">Sélectionne une commodité (ligne du tableau ou champ « Commodité ») pour voir tous ses points d\'achat et de vente.</p>'; return; }
  const p = commodityPoints(MARKET, commSelected, readFilters()); // exclut les avant-postes si le filtre est actif
  if (!p) { box.innerHTML = ""; return; }
  const buyRow = (b) => `<tr><td class="loc"><div>${esc(b.terminal)}${sysBadge(b.system)}${outpostTag(b.outpost)}</div><div class="loc-sub">${esc(b.planet)}</div></td><td class="num">${fmt(b.price)}</td><td class="num">${statusDot(b.status, "buy")} ${fmt(b.stock)}</td><td>${freshChip(b.updated)}</td></tr>`;
  const sellRow = (s) => `<tr><td class="loc"><div>${esc(s.terminal)}${sysBadge(s.system)}${outpostTag(s.outpost)}</div><div class="loc-sub">${esc(s.planet)}</div></td><td class="num">${fmt(s.price)}</td><td class="num">${statusDot(s.status, "sell")} ${fmt(s.demand)}</td><td>${freshChip(s.updated)}</td></tr>`;
  const table = (rows, head, mapper) => rows.length
    ? `<table class="comm-points"><thead><tr><th>Terminal</th><th class="num">Prix</th><th class="num">${head}</th><th>Relevé</th></tr></thead><tbody>${rows.map(mapper).join("")}</tbody></table>`
    : '<p class="muted">Aucun point.</p>';
  box.innerHTML =
    `<div class="comm-detail-head">${commodityIcon(p.kind)}<span class="comm-detail-title">${p.code ? `<b class="comm-code">${esc(p.code)}</b> · ` : ""}${esc(p.name)}${illegalTag(p.illegal)}</span></div>
     <div class="comm-cols">
       <div class="comm-col"><h4>◈ Où acheter <span class="muted">(${p.buys.length} · moins cher d'abord)</span></h4>${table(p.buys, "Stock", buyRow)}</div>
       <div class="comm-col"><h4>◈ Où vendre <span class="muted">(${p.sells.length} · mieux payé d'abord)</span></h4>${table(p.sells, "Demande", sellRow)}</div>
     </div>`;
}

function renderCommodities() {
  if (!MARKET) { loadMarket().then(() => { setupEnRoute(); renderCommodities(); }); return; }
  if (!enrouteReady) setupEnRoute();
  const f = readFilters();
  const q = f.q;
  let rows = commoditySummaries(MARKET, f).filter( // légales + avant-postes s'appliquent ici
    (c) => !q || c.name.toLowerCase().includes(q) || (c.code && c.code.toLowerCase().includes(q))
  );
  sortCommodities(rows);
  shownCommodities = rows;
  commMaxMargin = rows.reduce((mx, c) => Math.max(mx, c.margin || 0), 0); // pour la heatmap relative
  commCarried = journeyCarriedCommodities(); // commodités du voyage à surligner
  // Sélection : garde la commodité choisie si toujours visible, sinon prend la 1re.
  if (commSelected && !rows.some((r) => r.name === commSelected)) commSelected = null;
  if (!commSelected && rows.length) commSelected = rows[0].name;
  $("commGrid").innerHTML = rows.map(commodityTileHTML).join("");
  // Bouton de mode de tri actif.
  document.querySelectorAll("#commSortModes button").forEach((b) => b.classList.toggle("active", b.dataset.sort === commMode));
  paintCommodityDetail();
  notifySuperseded();
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
  $("viewChain").addEventListener("click", () => switchView("chain"));
  $("viewCorrections").addEventListener("click", () => switchView("corrections"));
  $("viewCommodities").addEventListener("click", () => switchView("commodities"));
  $("share").addEventListener("click", copyShareLink);
  // Contrôles « Commodités » : modes de tri + sélection d'une tuile.
  $("commSortModes").addEventListener("click", (e) => { const b = e.target.closest("button[data-sort]"); if (b) setCommSort(b.dataset.sort); });
  $("commGrid").addEventListener("click", (e) => {
    const tile = e.target.closest(".comm-tile");
    if (!tile) return;
    commSelected = tile.dataset.name;
    document.querySelectorAll("#commGrid .comm-tile").forEach((t) => t.classList.toggle("selected", t.dataset.name === commSelected));
    paintCommodityDetail();
    saveState();
  });
  // Contrôles « En route ».
  $("origin").addEventListener("input", () => { resolveOrigin(); refresh(); });
  $("destSystem").addEventListener("input", refresh);
  $("destTerminal").addEventListener("input", refresh); // terminal d'arrivée forcé
  // Contrôles « Chaîne ».
  $("chainOrigin").addEventListener("input", () => { resolveChainOrigin(); refresh(); });
  $("hops").addEventListener("input", refresh);
  // Contrôles « Corrections » : recherche de station + suppression / reset (délégué).
  $("station").addEventListener("input", () => { resolveStation(); refresh(); });
  $("corrections").addEventListener("click", (e) => {
    const del = e.target.closest(".corr-del");
    if (del) { delete OVERRIDES[del.dataset.key]; saveOverrides(); updateOvBadge(); refresh(); return; }
    if (e.target.closest("#resetAll")) resetAllOverrides();
  });
  // Manifeste : ajustement des SCU + ajout (suggéré ou libre) + retrait d'une ligne.
  $("manifest").addEventListener("input", (e) => {
    if (e.target.classList.contains("mqty-input")) updateManifestTotals();
  });
  $("manifest").addEventListener("click", (e) => {
    if (e.target.closest("#copyManifest")) { copyManifest(); return; }
    if (e.target.closest("#manifestAddBtn")) { addManifestCommodity($("manifestAddInput").value); return; }
    const del = e.target.closest(".mline-del");
    if (del) { removeManifestLine(del.dataset.name); return; }
    const add = e.target.closest(".suggest-add");
    if (add) addSuggestion(add.dataset.name);
  });
  $("manifest").addEventListener("keydown", (e) => {
    if (e.target.id === "manifestAddInput" && e.key === "Enter") { e.preventDefault(); addManifestCommodity(e.target.value); }
  });
  // Schéma de trajet : déplie/replie une ligne détaillée sous la ligne cliquée.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".route-toggle");
    if (!btn) return;
    const tr = btn.closest("tr");
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("schema-row")) { next.remove(); btn.classList.remove("open"); return; }
    const tableId = btn.closest("table").id;
    const arr = tableId === "loops" ? shownLoops : tableId === "enroute" ? shownEnroute : shownRoutes;
    const item = arr[Number(btn.dataset.row)];
    if (!item) return;
    const html = tableId === "loops" ? loopSchemaHTML(item) : routeSchemaHTML(item);
    tr.insertAdjacentHTML("afterend", `<tr class="schema-row"><td colspan="${tr.children.length}">${html}</td></tr>`);
    btn.classList.add("open");
  });
  // Compagnon de voyage : ▶ sélectionne un trajet (Trajets / En route) ; ✕ efface le parcours.
  document.addEventListener("click", (e) => {
    const pick = e.target.closest(".journey-pick");
    if (pick) {
      const tableId = pick.closest("table").id;
      const i = Number(pick.dataset.row);
      // Boucle : on entre dans le cycle par la fin du parcours (elle est marquée « from-here » si
      // l'un OU l'autre de ses bouts y touche) -> elle étend le voyage au lieu de le remplacer.
      if (tableId === "loops") { const l = shownLoops[i]; if (l) pickJourney(legsFromLoop(l, JOURNEY ? journeyEnd(JOURNEY)?.name : null)); }
      else { const r = (tableId === "enroute" ? shownEnroute : shownRoutes)[i]; if (r) pickJourney([legFromRoute(r)]); }
      return;
    }
    if (e.target.closest("#chainToJourney") && shownChain) { pickJourney(legsFromChain(shownChain, MARKET.terminals)); return; }
    if (e.target.closest("#journeyClear")) { clearJourney(); return; }
    // Démarrer un voyage « de zéro » : bouton « Commencer » depuis l'invite.
    if (e.target.closest("#journeyStartBtn")) { beginJourney($("journeyStart").value); return; }
    // Ajout d'arrêt : bouton « + Arrêt » ou une suggestion.
    if (e.target.closest("#journeyAddBtn")) { addStopByTerminal($("journeyAddStop").value); return; }
    const sug = e.target.closest(".jstop-suggest");
    if (sug) { addStopByTerminal(sug.dataset.label); return; }
    // Retirer un arrêt (✕ sur une étape) -> reconnexion des voisins.
    const del = e.target.closest(".jstep-del");
    if (del) { removeJourneyStop(Number(del.dataset.i)); return; }
    // Édition du manifeste d'une jambe : déplier / retirer / ajouter / réinitialiser.
    const legSug = e.target.closest(".jman-suggest .suggest-add");
    if (legSug) { addLegSuggestion(Number(legSug.dataset.leg), legSug.dataset.name); return; }
    const legDel = e.target.closest(".jman-del");
    if (legDel) { delLegLine(Number(legDel.dataset.leg), legDel.dataset.name); return; }
    if (e.target.closest(".jman-reset")) { resetLeg(Number(e.target.closest(".jman-reset").dataset.leg)); return; }
    const addBtn = e.target.closest(".jman-add-btn");
    if (addBtn) { addLegLine(Number(addBtn.dataset.leg), addBtn.closest(".jman-add").querySelector(".jman-add-input").value); return; }
    const head = e.target.closest(".jleg-head");
    if (head) { toggleLegEditor(Number(head.dataset.leg)); return; }
    // Parcours interactif : clic sur une étape (⦿) = « je suis ici » -> recale les vues.
    const step = e.target.closest(".jstep");
    if (step && JOURNEY) {
      JOURNEY = setJourneyPosition(JOURNEY, Number(step.dataset.i));
      syncViewsToJourney();
      renderJourney();
      refresh();
    }
  });
  // Ajout d'arrêt / de commodité à la touche Entrée.
  document.addEventListener("keydown", (e) => {
    if (e.target.id === "journeyStart" && e.key === "Enter") { e.preventDefault(); beginJourney(e.target.value); }
    else if (e.target.id === "journeyAddStop" && e.key === "Enter") { e.preventDefault(); addStopByTerminal(e.target.value); }
    else if (e.target.classList && e.target.classList.contains("jman-add-input") && e.key === "Enter") { e.preventDefault(); addLegLine(Number(e.target.dataset.leg), e.target.value); }
  });
  // Précharge le marché quand on focus un champ terminal du compagnon -> peuple le datalist.
  document.addEventListener("focusin", (e) => {
    if ((e.target.id === "journeyStart" || e.target.id === "journeyAddStop") && !enrouteReady) {
      if (MARKET) setupEnRoute();
      else loadMarket().then(() => setupEnRoute());
    }
  });
  // SCU d'une ligne de jambe : suggestions/profit en direct à la frappe, persistance au blur/Entrée.
  document.addEventListener("input", (e) => {
    if (e.target.classList && e.target.classList.contains("jman-qty")) liveLegQty(Number(e.target.dataset.leg), Number(e.target.dataset.i), e.target);
  });
  document.addEventListener("change", (e) => {
    if (e.target.classList && e.target.classList.contains("jman-qty")) editLegQty(Number(e.target.dataset.leg), Number(e.target.dataset.i), e.target.value);
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
  // Raccourcis clavier : / (recherche), 1/2/3 (vues). Ignorés pendant la saisie.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.classList.contains("editv"))) return;
    if (e.key === "/") { e.preventDefault(); $("search").focus(); }
    else if (e.key === "1") switchView("routes");
    else if (e.key === "2") switchView("loops");
    else if (e.key === "3") switchView("enroute");
    else if (e.key === "4") switchView("chain");
    else if (e.key === "5") switchView("corrections");
    else if (e.key === "6") switchView("commodities");
  });
  loadOverrides();
  loadJourneyEdits();
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
      const ageH = (Date.now() / 1000 - meta.generated_at) / 3600;
      const rel = ageH < 1 ? "il y a moins d'1 h" : ageH < 24 ? `il y a ${Math.round(ageH)} h` : `il y a ${Math.round(ageH / 24)} j`;
      const stale = ageH > 6; // données rafraîchies chaque heure : au-delà de 6 h, pipeline suspect
      const tier = stale ? "f-old" : ageH < 3 ? "f-good" : "f-ok"; // couleurs de fraîcheur partagées
      const exact = d.toLocaleString("fr-FR");
      // Haut-droite : indicateur de fraîcheur uniquement.
      $("meta").innerHTML =
        `<span class="freshness-ind ${tier}" title="Données UEX du ${exact}"><span class="fi-dot"></span>Données ${rel}${stale ? " ⚠" : ""}</span>`;
      // Bas du rail (« Flux UEX ») : dernière mise à jour + compteurs.
      const rs = $("railStatus");
      if (rs) rs.innerHTML =
        `<div class="rs-updated">Dernière MàJ<br><b>${exact}</b></div>` +
        `<div class="rs-counts"><b>${meta.routes}</b> routes · <b>${meta.loops ?? LOOPS.length}</b> boucles · <b>${meta.commodities}</b> commodités</div>`;
    }
    // Applique l'état restauré une fois le menu système peuplé, puis affiche la bonne vue.
    applyState(saved);
    showShipCard(); // ré-affiche la carte du vaisseau restauré (image comprise)
    renderJourney(); // ré-affiche le parcours restauré (compagnon de voyage)
    switchView(view);
  } catch (e) {
    $("meta").textContent = "Erreur de chargement des données.";
    $("empty").hidden = false;
    $("empty").textContent = "Impossible de charger data/routes.json — lance le script de mise à jour.";
    console.error(e);
  }
}

init();

// PWA : installable + consultable hors-ligne (ignoré si non supporté / hors contexte sécurisé).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
