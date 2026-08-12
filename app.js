"use strict";

// Fonctions de calcul pures (testées par logic.test.mjs).
import {
  tripMinutes, ageDays, pairAge,
  normalizeScores, bySort, addableUnits, scuBoxes, cargoBoxes, bestChain,
  AUTOLOAD, autoloadFee, autoloadPoint, haulFee, lineHaulFee,
  ovKey, effFromStore, setInStore, safeKey, encodeState, decodeState,
  routePasses, loopPasses,
  routeMetrics, loopMetrics, enRouteDeals, bestManifest, buildChainAdjacency, suggestionsFrom, netMarginRoi,
  commoditySummaries, commodityPoints, compactValue, valueTiers, resolveCommodity, ambiguousCodes,
  manifestTotals, freeAddUnits, manifestLine, freeManifestLine, hydrateManifestLine, stationLabel, parseStationLabel,
  multiTrips, tripMetrics, legFromTrip,
  legFromRoute, legsFromLoop, legsFromChain, legFromManifest, stopSuggestions, bestLegBetween,
  manifestJourneyState, manifestIntent, sameIntent, legsToPin, journeyMap,
  loadHold, holdScu, freeCargo, holdByCommodity, sellFromHold, refuseHere, sellableAt, sellAllAt,
  offloadPlan, storeFromHold, stockApres,
  startJourney, startJourneyAt, journeyStations, journeyEnd,
  journeyConnects, addToJourney, setJourneyPosition, currentLeg, journeyMargin,
  removeJourneyStop as removeStopPure,
  encodeJourney, decodeJourney,
} from "./logic.mjs";

// Libellé compact des caisses SCU standard, ex. « 8×32 · 1×16 · 1×4 · 1×2 · 1×1 ».
// `maxBox` = plafond de caisse du terminal de CHARGEMENT, quand on le connaît : c'est une propriété
// physique de la station, indépendante de l'interrupteur de frais. On le propage partout où le
// terminal d'achat est disponible, parce que c'est exactement la décomposition que la facture
// d'autoload utilise — un « 📦 1×32 » à côté d'un montant calculé sur deux caisses de 16 serait
// une incohérence directement visible.
const boxesLabel = (boxes) => (boxes.length ? boxes.map((b) => `${b.count}×${b.size}`).join(" · ") : "");
function scuBoxesLabel(n, maxBox) {
  return boxesLabel(scuBoxes(n, maxBox));
}
// Même libellé pour un chargement à plusieurs commodités : une caisse ne contient qu'une commodité,
// la décomposition se fait donc ligne par ligne (cargoBoxes) et jamais sur le total des SCU.
const cargoBoxesLabel = (lines, maxBox) => boxesLabel(cargoBoxes(lines, maxBox));

// État global
let ROUTES = [];
let LOOPS = [];
let view = "routes"; // "routes" | "loops"
let sortKey = "score";
let sortDir = -1; // -1 = décroissant, 1 = croissant
let loopSortKey = "score";
let loopSortDir = -1;
// Lignes actuellement affichées (dans l'ordre du DOM) pour déplier le schéma de trajet.
let shownRoutes = [], shownEnroute = [], shownLoops = [], shownMulti = [];
// Vue « Commodités » : mode de tri (margin|code|kind|custom), clé/sens custom, sélection.
let commMode = "margin", commSortKey = "margin", commSortDir = -1, commSelected = null, shownCommodities = [];
// Board « Commodités » : "market" = marge achat→vente ; "loot" = prix de revente d'une ressource
// trouvée (le coût d'acquisition est nul, la marge n'a plus de sens).
let commBoard = "market", commTiers = new Map();
// Codes UEX portés par plusieurs commodités du board courant : leurs tuiles affichent le nom,
// sinon elles seraient rigoureusement identiques à l'écran (COPP = Copper ET Copper (Ore)).
let commDupCodes = new Set();
let commMaxMargin = 0; // marge max de la liste courante (pour colorer la heatmap en relatif)
let commCarried = new Set(); // commodités transportées au moins 1 fois dans le voyage (highlight board)
// Compagnon de voyage : parcours sélectionné { legs[], current } ou null.
let JOURNEY = null;
// Affiche la carte du vaisseau correspondant au champ (défini par loadShips ; utilisé à la restauration).
let showShipCard = () => {};

const STATE_KEY = "best-hauling-state";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString("fr-FR"));
// Volume dont le null veut dire « capacité non communiquée par UEX » et non « zéro » :
// `scu_sell` n'est renseigné que sur une minorité de points de vente. Un « — » s'y lisait
// « aucune demande » alors qu'aucun plafond n'est appliqué dans ce cas — d'où « n.c. ».
const fmtVol = (n) => (n == null ? "n.c." : fmt(n));
const VOL_UNKNOWN_HINT = "Capacité non communiquée par UEX : aucun plafond de volume n'est appliqué";

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

// ---------- Frais d'autoload : tarif par station + contexte de calcul ----------
// Le calcul est PUR et vit dans logic.mjs (autoloadFee / autoloadPoint / haulFee). app.js n'y
// apporte que ce que logic.mjs ne peut pas deviner sans lire une globale : quel terminal porte
// quel nom, et combien CETTE station facture. Deux résolutions, donc :
//   - nom de terminal -> terminal de market.json, parce que routes.json et loops.json (vues
//     « Trajets » et « Boucles ») ne portent que des noms ;
//   - terminal -> coefficient `k`, relevé par l'utilisateur ou valeur globale par défaut.
const AUTOLOAD_KEY = "best-hauling-autoload";
const K_DEFAULT = 1.2; // milieu des deux seules stations mesurées (Endgame 1,0 et Ruin 1,4)

// { "autoload|<terminal>": { k, amount, scu } } — même forme de clé et même mécanique que les
// corrections locales (localStorage, jamais partagé, jamais dans le lien), mais un STORE À PART.
// Les ranger dans OVERRIDES casserait trois consommateurs qui supposent tous qu'une clé du store
// est une correction prix/stock à TROIS segments : ovCount() les compterait dans le badge « ✎
// Corrections (n) », correctionsListHTML() lirait « autoload|<terminal> » comme commodité/terminal/
// side et rendrait une correction « vente » vide, et « Tout réinitialiser » les effacerait sans le
// dire. S'y ajoutent deux incompatibilités de fond : setInStore arrondit à l'entier (un k de 1,41
// deviendrait 1) et effValue périme une correction dès qu'UEX republie le point, alors qu'un tarif
// de manutention n'a aucune date UEX de référence et n'a donc aucune raison de périmer.
let AUTOLOAD_K = {};
const alKey = (terminal) => `autoload|${terminal}`;
function loadAutoloadK() { try { AUTOLOAD_K = JSON.parse(localStorage.getItem(AUTOLOAD_KEY)) || {}; } catch { AUTOLOAD_K = {}; } }
function saveAutoloadK() { try { localStorage.setItem(AUTOLOAD_KEY, JSON.stringify(AUTOLOAD_K)); } catch {} }

// Coefficient global, appliqué à toute station non relevée. Une saisie vide ou absurde retombe sur
// le défaut : `Number("")` vaut 0, et un k nul annulerait silencieusement tous les frais.
const globalK = () => { const v = Number($("alk").value); return v > 0 ? v : K_DEFAULT; };
const kFor = (terminal) => { const o = AUTOLOAD_K[alKey(terminal)]; return o && o.k > 0 ? o.k : globalK(); };

// Déduit k d'un montant observé en jeu : personne ne lit un coefficient à l'écran, on lit une
// facture. k = montant payé / montant que la formule prédirait au tarif d'ancrage (k = 1).
// null quand la mesure ne dit rien (quantité nulle, montant absurde).
function kFromReading(amount, scu, maxBox) {
  const ref = autoloadFee(scu, maxBox, 1);
  if (!(ref > 0) || !(amount > 0)) return null;
  return Math.round((amount / ref) * 1000) / 1000;
}

// Ce qu'UNE extrémité facture. `point` est ce que consomme logic.mjs ; les autres champs servent à
// EXPLIQUER le chiffre à l'écran — « cette station ne propose pas l'autoload » et « UEX ne nous a
// pas dit si elle le propose » aboutissent au même 0 mais ne se racontent pas pareil, et aucun des
// deux ne doit se lire comme un frais oublié.
function feeEnd(name, terminal) {
  const t = terminal || termByName.get(name) || null;
  const k = kFor(name);
  return {
    name, k, point: autoloadPoint(t, k),
    known: !!t && t.autoload != null, // champ absent = instantané de market.json antérieur au build
    available: !!t && t.autoload === true,
    maxBox: t ? t.maxBox : undefined,
    measured: !!AUTOLOAD_K[alKey(name)],
  };
}

// Contexte de frais d'un chargement A -> B. `null` dès que l'interrupteur est inactif, et c'est
// littéralement ce que « inactif » veut dire pour tout le moteur : sans contexte, chaque fonction
// de logic.mjs rend exactement les valeurs brutes qu'elle rendait avant que les frais n'existent.
function feeCtx(f, buyName, sellName, buyT, sellT) {
  if (!f.autoload) return null;
  // Marché pas encore chargé (premier rendu de « Trajets » / « Boucles ») : aucun terminal n'est
  // résolvable, donc aucun frais n'est calculable. On rend le brut SANS marqueur — prétendre
  // « aucune de ces stations ne facture » serait faux — et ensureFeeMarket re-rend à l'arrivée.
  if (!buyT && !sellT && !termByName.size) return null;
  const a = feeEnd(buyName, buyT), b = feeEnd(sellName, sellT);
  return { a, b, pair: { buy: a.point, sell: b.point } };
}

// Résolveur passé aux fonctions de logic.mjs qui parcourent le marché : elles découvrent leurs
// terminaux en chemin et n'ont donc aucun nom à nous donner d'avance.
const feeResolver = (f) => (f.autoload ? (t) => autoloadPoint(t, kFor(t && t.name)) : null);

// Un montant qui incorpore des frais d'autoload est une ESTIMATION : la formule colle aux 18
// relevés à 2,8 % près, et `k` varie de 40 % entre les deux seules stations mesurées. Le « ≈ » le
// dit, partout où le chiffre a été amputé.
const fmtFee = (n, fees) => (fees > 0 ? "≈ " + fmt(n) : fmt(n));
const kText = (e) => `×${e.k.toLocaleString("fr-FR", { maximumFractionDigits: 3 })} ${e.measured ? "(relevé)" : "(k global)"}`;
function feeEndText(e) {
  if (!e.known) return `${e.name} : autoload inconnu (donnée UEX absente) — rien facturé`;
  if (!e.available) return `${e.name} : pas d'autoload — rien facturé`;
  return `${e.name} ${kText(e)}`;
}
// Décrit la manutention facturée, et avec quelle formule : l'infobulle doit permettre de REFAIRE le
// calcul, sinon elle explique un montant qu'elle contredit. D'où deux textes, parce qu'il y a deux
// facturations — une transaction pour un chargement à une commodité, une PAR commodité au-delà
// (hypothèse 2 de la spec), et autant de fois la base de 150.
const FEE_FORMULA = `${AUTOLOAD.base} + ${AUTOLOAD.perBox}/caisse + ${AUTOLOAD.perScu}/SCU`;
const boxCount = (boxes) => boxes.reduce((a, b) => a + b.count, 0);
function feeLoadText(scu, maxBox) {
  const n = boxCount(scuBoxes(scu, maxBox));
  return `${fmt(scu)} SCU en ${n} caisse${n > 1 ? "s" : ""}, chargement + déchargement · ${FEE_FORMULA} par opération`;
}
// Chargement MULTI-commodité : les caisses se comptent ligne par ligne (une caisse = une commodité)
// et la base est facturée par commodité. Décrire le total en une seule opération annonçait un
// nombre de caisses et une formule qui ne redonnaient pas le montant déduit.
function feeCargoText(lines, maxBox) {
  const n = boxCount(cargoBoxes(lines, maxBox));
  const scu = lines.reduce((a, l) => a + (l.units || 0), 0);
  const p = lines.length;
  return `${fmt(scu)} SCU en ${n} caisse${n > 1 ? "s" : ""} sur ${p} commodité${p > 1 ? "s" : ""}, chargement + déchargement · ${FEE_FORMULA} par commodité et par opération`;
}

// Infobulle + marqueur d'une cellule de profit soumise aux frais. `what` décrit la manutention et
// n'est appelée que si elle sert : l'interrupteur inactif est le cas courant, et ce chemin est
// parcouru une fois par ligne de tableau.
// `bounded` = la route a un volume : sans volume aucun frais n'est calculable (le profit est déjà
// « — »), et rien ne doit laisser croire à un oubli. Quand l'interrupteur est actif mais qu'aucune
// des deux stations ne facture, l'infobulle DIT pourquoi et un ⊘ discret le signale — un profit
// resté brut au milieu d'une colonne nette, sans un mot, se lit comme un bug. Le marqueur ne va que
// sur la colonne « profit » : le répéter sur « profit/heure » doublerait le bruit sans rien ajouter.
const NO_FEE_CELL = { attr: "", mark: "", text: "" };
function feeCell(ctx, fees, what, bounded) {
  if (!ctx || !bounded) return NO_FEE_CELL;
  const text = fees > 0
    ? `Frais d'autoload ≈ ${fmt(fees)} aUEC déduits — ${what()} · ${feeEndText(ctx.a)} · ${feeEndText(ctx.b)} · estimation ±3 %`
    : `Aucun frais d'autoload sur ce trajet — ${feeEndText(ctx.a)} · ${feeEndText(ctx.b)}`;
  return { attr: ` title="${esc(text)}"`, mark: fees > 0 ? "" : ' <span class="nofee">⊘</span>', text };
}
// Compose une infobulle existante avec le détail des frais (cellule profit/heure).
const withFeeText = (base, cell) => esc(cell.text ? `${base} · ${cell.text}` : base);

// Frais et profit NET d'une ligne de manifeste. Hypothèse 2 de la spec : une transaction PAR
// COMMODITÉ, donc chaque ligne paie sa propre base — sans quoi la somme des lignes affichées ne
// ferait pas le total affiché, l'incohérence la plus visible qui soit. Le décompte des opérations
// vit dans logic.mjs (lineHaulFee), qui sait qu'une ligne « vend ailleurs » n'est pas déchargée et
// qu'une ligne « acquis ailleurs » n'a pas été chargée : c'est la MÊME règle que manifestTotals,
// donc le total et les lignes ne peuvent pas diverger.
const lineNet = (units, l, pair) => units * (l.margin || 0) - lineHaulFee(units, l, pair);
// Texte de la cellule « profit » d'une ligne de manifeste. Partagé par le premier rendu et par la
// mise à jour en direct : deux conventions différentes et éditer une quantité changerait le sens
// de la cellule. Une ligne « vend ailleurs » n'a pas de profit sur ce trajet — elle a quand même
// été chargée, et ce chargement, lui, est bien retranché du total.
function lineProfitText(units, l, pair) {
  const fees = lineHaulFee(units, l, pair);
  if (l.sellPrice == null) return fees > 0 ? fmtFee(-fees, fees) : "—";
  return "+" + fmtFee(lineNet(units, l, pair), fees);
}

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
  const { buy, sell, margin } = applyOverrides(r.commodity, r.buy, r.sell);
  // routes.json et enRouteDeals ne donnent que des NOMS de terminaux : c'est ici, du côté impur,
  // qu'ils deviennent des tarifs. routeMetrics, lui, reçoit un contexte déjà résolu.
  const feeInfo = feeCtx(f, buy.terminal, sell.terminal);
  const metrics = routeMetrics({
    buyPrice: buy.price, buyStock: buy.stock, sellDemand: sell.demand, margin,
    distance: r.distance, sameSystem: r.same_system,
    buyUpdated: buy.updated, sellUpdated: sell.updated,
    demandKnown: sell.ovVol, // ovVol = demande corrigée par l'utilisateur = fiable
  }, f, feeInfo && feeInfo.pair);
  // Marge et ROI nets des frais, comme en mode multi : la même colonne garde la même définition
  // d'un mode à l'autre. Sans frais, netMarginRoi rend exactement la marge de marché et l'ancien ROI.
  const net = netMarginRoi(margin, buy.price, metrics.units, metrics.fees);
  return { ...r, buy, sell, buyPrice: buy.price, sellPrice: sell.price, feeInfo, ...metrics, ...net };
}

// Cellule visuelle du score : mini-barre + valeur.
function scoreCell(score) {
  const tier = score >= 70 ? "s-good" : score >= 40 ? "s-ok" : "s-low";
  return `<div class="score-cell"><span class="scorebar ${tier}"><i style="width:${score}%"></i></span><b>${score}</b></div>`;
}

// Valeur éditable (clic pour corriger localement). side = "buy"|"sell", field = "price"|"vol".
// updated = date UEX du point (mémorisée comme base de fraîcheur de la correction).
function editv(commodity, terminal, side, field, value, ov, updated) {
  // `data-v` et `data-u` étaient les deux seules interpolations du rendu à ne pas passer par esc().
  // Elles reçoivent des champs UEX, que le pipeline coerce désormais en nombre (numField) — mais un
  // instantané déjà déployé, ou un data/ servi depuis le cache du service worker, peut encore
  // contenir n'importe quoi. Une valeur non numérique n'a de toute façon aucun sens ici : le champ
  // number de l'éditeur la rejetterait. On la ramène donc à « inconnu » plutôt que de l'écrire.
  const v = Number.isFinite(Number(value)) ? Number(value) : null;
  const u = Number.isFinite(Number(updated)) ? Number(updated) : 0;
  // value null = capacité inconnue chez UEX, affichée « n.c. » (cf. fmtVol). On n'injecte pas la
  // chaîne "null" dans data-v, sinon le champ number la rejette à l'ouverture de l'édition.
  const unknown = value == null || v == null;
  const hint = unknown ? `${VOL_UNKNOWN_HINT}. Clic pour le corriger localement` : "Clic pour corriger localement ce chiffre";
  return `<span class="editv${unknown ? " nc" : ""}${ov ? " ov" : ""}" data-c="${esc(commodity)}" data-t="${esc(terminal)}" data-s="${side}" data-f="${field}" data-v="${unknown ? "" : esc(v)}" data-u="${esc(u)}" role="button" tabindex="0" title="${hint}">${fmtVol(value)}${ov ? '<span class="ovmark" title="Corrigé localement">✎</span>' : ""}</span>`;
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
    multi: $("multiCommodity").checked,
    // « avec les simples » : les chargements à UNE commodité rentrent dans le même classement que
    // les combinés. Par défaut ils en sont exclus — ils sont déjà dans la vue « Trajets » normale.
    multiAll: $("multiMode").value === "all",
    autoload: $("autoload").checked,
  };
}

// Mode « Multi commodité » actif (uniquement pertinent dans la vue Trajets).
const isMultiRoutes = () => view === "routes" && $("multiCommodity").checked;

// Message de #empty tel qu'il est écrit dans index.html. Le <p> est PARTAGÉ par les vues Trajets /
// Boucles / En route, et « En route » comme le mode multi-commodité réécrivent son texte : sans
// remise à zéro en tête de rendu, un état vide légitime affichait le message d'une AUTRE vue.
const EMPTY_DEFAULT = "Aucune route ne correspond aux filtres.";

function render() {
  const f = readFilters();
  $("empty").textContent = EMPTY_DEFAULT;
  if (f.multi) return renderMulti(f);
  ensureFeeMarket(f, refresh); // re-rend la vue RÉELLEMENT active à l'arrivée du marché, pas celle d'alors

  let rows = ROUTES.filter((r) => routePasses(r, f)).map((r) => evaluate(r, f));

  normalizeScores(rows);
  rows.sort(bySort(sortKey, sortDir));

  shownRoutes = rows;
  $("rows").innerHTML = rows.map(routeRowHTML).join("");
  $("empty").hidden = rows.length > 0;
  notifySuperseded();
}

// ---------- Vue « Trajets » en mode MULTI-COMMODITÉ ----------
// Même tableau, mais chaque ligne est un chargement A->B composé de PLUSIEURS commodités
// (remplissage par marge décroissante, plafonné par stock/demande et budget).
function renderMulti(f) {
  const empty = $("empty");
  // Sans soute bornée, « remplir la soute » n'a pas de sens (cf. manifeste d'« En route »).
  if (!f.useCargo || !(f.cargo > 0)) {
    shownMulti = [];
    $("rows").innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Active la soute (SCU) pour calculer des trajets multi-commodité.";
    return;
  }
  if (!MARKET) { withMarket(refresh); return; } // graphe requis
  // Le contexte de frais descend DANS multiTrips (et non après coup) : c'est lui qui trie puis
  // TRONQUE à 300 trajets, un trajet meilleur en net serait donc coupé avant d'atteindre le tableau.
  const trips = multiTrips(MARKET, f, effVals, 300, f.multiAll ? 1 : 2, feeResolver(f))
    .map((t) => ({ ...t, feeInfo: feeCtx(f, t.origin.name, t.dest.name, t.origin, t.dest), ...tripMetrics(t) }));
  normalizeScores(trips);
  trips.sort(bySort(sortKey, sortDir));
  shownMulti = trips;
  $("rows").innerHTML = trips.map(multiRowHTML).join("");
  empty.hidden = trips.length > 0;
  // Rappel : seuls les chargements COMBINÉS (≥ 2 commodités) sont listés ici — un trajet dont le
  // remplissage optimal tient en une seule commodité est déjà dans la vue « Trajets » normale.
  if (!trips.length) {
    empty.textContent = f.multiAll
      ? "Aucun chargement depuis ces terminaux avec ces filtres — élargis la soute ou le budget."
      : "Aucun chargement combinant plusieurs commodités avec ces filtres — agrandis la soute, ou passe la liste sur « avec les simples ».";
  }
  notifySuperseded();
}

// Ligne de tableau d'un trajet multi-commodité (mêmes colonnes que les trajets simples).
function multiRowHTML(t, i) {
  const n = t.lines.length;
  const fc = feeCell(t.feeInfo, t.fees, () => feeCargoText(t.lines, t.origin.maxBox), t.units > 0);
  const cross = t.cross ? '<span class="cross">⚡ saut inter-système</span>' : "";
  const icons = t.lines.slice(0, 6).map((l) => commodityIcon(l.kind)).join("");
  const more = n > 6 ? `<span class="muted">+${n - 6}</span>` : "";
  const names = t.lines.map((l) => `${l.name} (${fmt(l.units)} SCU)`).join(" · ");
  const oldest = t.lines.reduce((m, l) => { const u = lineFreshUpdated(l); return m && u ? Math.min(m, u) : m || u; }, 0);
  return `
      <tr data-row="${i}">
        <td class="loc">
          <div class="commodity-cell"><button class="route-toggle" data-row="${i}" title="Voir le chargement" aria-label="Voir le chargement">🗺</button><button class="journey-pick" data-row="${i}" title="Faire ce trajet — compagnon de voyage" aria-label="Sélectionner ce trajet">▶</button><span class="multi-icons" title="${esc(names)}">${icons}${more}</span><span class="cname">${n} commodité${n > 1 ? "s" : ""}</span></div>
          <div class="loc-badges">${t.lines.some((l) => l.illegal) ? illegalTag(true) : ""}${cross}</div>
        </td>
        <td class="loc">
          <div class="term-name">${esc(t.origin.name)}</div>
          <div class="loc-badges">${sysBadge(t.origin.system)}${outpostTag(t.origin.outpost)}</div>
          <div class="loc-sub">${esc(t.origin.planet)}</div>
          <div class="loc-fresh">${freshChip(oldest)}</div>
        </td>
        <td class="loc">
          <div class="term-name">${esc(t.dest.name)}</div>
          <div class="loc-badges">${sysBadge(t.dest.system)}${outpostTag(t.dest.outpost)}</div>
          <div class="loc-sub">${esc(t.dest.planet)}</div>
        </td>
        <td>${scoreCell(t.score)}</td>
        <td class="num" title="${withFeeText("Marge moyenne pondérée par SCU chargé", fc)}">${fmtFee(t.margin, t.fees)}</td>
        <td class="num roi-badge"${fc.attr}>${t.fees > 0 ? "≈ " : ""}${t.roi}%</td>
        <td class="num"${t.units ? ` title="Caisses : ${cargoBoxesLabel(t.lines, t.origin.maxBox)}"` : ""}>${fmt(t.units)}</td>
        <td class="num">${fmt(t.investment)}</td>
        <td class="num profit"${fc.attr}>${fmtFee(t.profit, t.fees)}${fc.mark}</td>
        <td class="num profit" title="${withFeeText(`Estimation ${Math.round(t.minutes)} min/voyage (distance approchée)`, fc)}">${fmtFee(t.profitHour, t.fees)}</td>
      </tr>`;
}

// Détail déplié d'un trajet multi-commodité : schéma départ→arrivée + chargement ligne par ligne.
function multiSchemaHTML(t) {
  const info = `${t.cross ? "⚡ saut inter-système" : "même système"} · ~${Math.round(t.minutes)} min`;
  const end = (x) => ({ system: x.system, planet: x.planet, terminal: x.name, outpost: x.outpost });
  const schema = `<div class="schema">${schemaLeg("Départ", end(t.origin))}<div class="schema-arrow"><span class="al">⟶</span><span class="ai">${info}</span></div>${schemaLeg("Arrivée", end(t.dest))}</div>`;
  const lines = t.lines.map((l) =>
    `<div class="sline">${commodityIcon(l.kind)}` +
    `<span class="mname">${esc(l.name)}${illegalTag(l.illegal)}</span>` +
    `<span class="mstock">stock ${fmt(l.stock)} · dem. ${fmtVol(l.demand)}</span>` +
    `<span class="mprice">${fmt(l.buyPrice)} → ${fmt(l.sellPrice)} · marge ${fmt(l.margin)}</span>` +
    `<span class="mprofit profit">${lineProfitText(l.units, l, t.fee)}</span>` +
    `<span class="mboxes" title="Caisses SCU standard à charger">📦 ${fmt(l.units)} SCU · ${scuBoxesLabel(l.units, t.origin.maxBox)}</span></div>`
  ).join("");
  return `${schema}<div class="multi-cargo"><div class="suggest-head">Chargement — ${t.lines.length} commodité${t.lines.length > 1 ? "s" : ""}, ${fmt(t.units)}/${fmt(t.cargo)} SCU</div>${lines}</div>`;
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
  // Plafond de caisse du terminal d'ACHAT, lu du marché et non du contexte de frais : c'est une
  // propriété physique de la station (cf. scuBoxesLabel). Le prendre dans `feeInfo` le faisait
  // disparaître dès l'interrupteur relâché, et la ligne du tableau annonçait alors « 3×32 » à côté
  // d'un manifeste qui, lui, affichait « 6×16 » pour la même cargaison au même terminal.
  const maxBox = (termByName.get(r.buy.terminal) || {}).maxBox;
  const fc = feeCell(r.feeInfo, r.fees, () => feeLoadText(r.units, maxBox), r.units > 0);
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
          <div class="loc-sub">${esc(r.sell.planet)} · ${editv(r.commodity, r.sell.terminal, "sell", "price", r.sell.price, r.sell.ovPrice, r.sell.updated)} aUEC · ${statusDot(r.sell.status, "sell")}<span class="stock" title="Demande à la vente = capacité restante du terminal (relevé UEX)">demande ${editv(r.commodity, r.sell.terminal, "sell", "vol", r.sell.demand, r.sell.ovVol, r.sell.updated)} SCU</span></div>
          <div class="loc-fresh">${freshChip(r.sell.updated)}</div>
        </td>
        <td>${scoreCell(r.score)}</td>
        <td class="num"${fc.attr}>${fmtFee(r.margin, r.fees)}</td>
        <td class="num roi-badge"${fc.attr}>${r.fees > 0 ? "≈ " : ""}${r.roi}%</td>
        <td class="num"${r.units ? ` title="Caisses : ${scuBoxesLabel(r.units, maxBox)}"` : ""}>${fmt(r.units)}</td>
        <td class="num">${fmt(r.investment)}</td>
        <td class="num profit"${fc.attr}>${fmtFee(r.profit, r.fees)}${fc.mark}</td>
        <td class="num profit" title="${withFeeText(`Estimation ${Math.round(r.minutes)} min/voyage`, fc)}">${fmtFee(r.profitHour, r.fees)}</td>
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
  // Une boucle n'a pas un terminal d'achat et un de vente : elle a deux EXTRÉMITÉS qui sont tour à
  // tour l'un et l'autre, d'où { a, b } et quatre opérations facturées (cf. loopMetrics).
  const feeInfo = feeCtx(f, l.a.terminal, l.b.terminal);
  const metrics = loopMetrics(out, back, l.distance, cross, f, feeInfo && { a: feeInfo.a.point, b: feeInfo.b.point });
  return { ...l, out, back, cross, feeInfo, ...metrics };
}

function renderLoops() {
  const f = readFilters();
  $("empty").textContent = EMPTY_DEFAULT;
  ensureFeeMarket(f, refresh); // idem render() : la vue peut avoir changé pendant le fetch

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
    .map((l, i) => {
      // Quatre opérations par boucle : on charge et on décharge à chacun des deux bouts.
      const fc = feeCell(l.feeInfo, l.fees, () => `${fmt(l.unitsOut)} + ${fmt(l.unitsBack)} SCU, 4 opérations (charge et décharge à chaque bout)`, l.units > 0);
      return `
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
        <td class="num profit"${fc.attr}>${fmtFee(l.profit, l.fees)}${fc.mark}</td>
        <td class="num profit" title="${withFeeText(`Estimation ${Math.round(l.minutes)} min/boucle`, fc)}">${fmtFee(l.profitHour, l.fees)}</td>
      </tr>`;
    })
    .join("");

  $("empty").hidden = rows.length > 0;
  notifySuperseded();
}

// ---------- Mode « En route » (trajet dirigé) + manifeste multi-commodité ----------
let MARKET = null;            // graphe d'échange, chargé à la demande
let enrouteReady = false;     // datalist/destSystem peuplés une seule fois
let originMap = new Map();    // libellé « Nom — Système » -> index terminal (achat uniquement)
let stationMap = new Map();   // libellé -> index, TOUS les terminaux (pour la vue Corrections)
// Nom de terminal -> terminal de market.json. Pont indispensable aux frais d'autoload : routes.json
// et loops.json ne portent QUE des noms, et les noms sont déjà la clé métier du dépôt (corrections
// locales, jambes de voyage). Peuplée en même temps que stationMap.
let termByName = new Map();
let enrouteOrigin = null;     // index du terminal de départ sélectionné
let stationSel = null;        // index de la station sélectionnée (vue Corrections)

// Charge le graphe de marché à la demande. Deux règles, apprises à la dure :
//   - on mémorise la PROMESSE en vol, pas seulement son résultat : sinon chaque frappe pendant le
//     chargement relançait un fetch complet de market.json (4 requêtes concurrentes mesurées) ;
//   - on ne mémorise JAMAIS l'échec. Un marché vide mis en cache verrouillait « En route »,
//     « Chaîne », « Commodités » et « Corrections » pour TOUTE la session — autocomplétion vide,
//     0 tuile, « aucune chaîne rentable » — sans le moindre message, et seul un rechargement
//     complet réparait. L'erreur remonte donc aux appelants, et l'action suivante réessaie.
let MARKET_LOADING = null;
function loadMarket() {
  if (MARKET) return Promise.resolve(MARKET);
  if (!MARKET_LOADING) {
    MARKET_LOADING = fetch("data/market.json")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((m) => (MARKET = m))
      .catch((e) => { MARKET_LOADING = null; throw e; }); // rien n'est retenu -> réessai possible
  }
  return MARKET_LOADING;
}

// Géométrie des systèmes pour la carte du voyage (cf. ADR-001). 1,5 ko, chargé à la demande et une
// seule fois : la carte n'existe que s'il y a un voyage, inutile de le payer sur une page nue.
// Un échec ne bloque rien — la carte reste simplement absente, le reste du compagnon fonctionne.
let STARMAP = null, starmapPending = false;
function ensureStarmap(then) {
  if (STARMAP || starmapPending) return;
  starmapPending = true;
  fetch("data/starmap.json")
    .then((r) => r.json())
    .then((s) => { STARMAP = s; starmapPending = false; then(); })
    .catch(() => { starmapPending = false; }); // silencieux : un panneau décoratif n'alarme personne
}

// Prévient que le marché est indisponible plutôt que de laisser la vue vide ET muette.
const marketUnavailable = () => showToast("⚠ Marché indisponible — vérifie ta connexion, puis réessaie");

// Exécute `then` une fois le marché chargé et les datalists peuplées. Point de passage unique de
// toutes les vues qui ont besoin du graphe : c'est lui qui garantit que `setupEnRoute()` ne tourne
// jamais sur un marché vide (il pose `enrouteReady`, qui figerait les datalists une fois pour toutes).
// RÈGLE : une VUE ne se repasse jamais elle-même ici, elle passe `refresh` — le fetch dure, et
// l'utilisateur peut avoir changé de vue entre-temps. Rappeler son propre rendu repeignait alors
// #empty et #manifest (partagés par Trajets / Boucles / En route) par-dessus la vue quittée :
// message « choisis un terminal de départ » sous un tableau de trajets plein, ou inversement
// « aucune route ne correspond » masqué au-dessus d'un tableau vide. `renderJourney`, lui, n'est
// lié à AUCUNE vue (la carte Voyage est toujours à l'écran) et se repasse donc bien lui-même.
function withMarket(then) {
  loadMarket().then(() => { setupEnRoute(); then(); }).catch(marketUnavailable);
}

// Les vues « Trajets » et « Boucles » lisent routes.json / loops.json, qui ne portent que des NOMS
// de terminaux : `autoload` et `maxBox` n'existent que dans market.json, que ces deux vues n'ont
// jamais eu besoin de charger. On le charge donc en TÂCHE DE FOND et on re-rend à l'arrivée, plutôt
// que de retarder — ou de vider — la vue par défaut de l'app derrière un fetch de 85 ko : le tableau
// reste lisible, ses profits simplement bruts le temps du chargement.
// En cas d'échec on NE re-rend PAS : ce re-rendu rappellerait ensureFeeMarket, qui relancerait un
// fetch (loadMarket ne mémorise jamais l'échec), en boucle. La prochaine action de l'utilisateur
// réessaiera, ce qui est exactement la règle de loadMarket.
let feeMarketPending = false;
function ensureFeeMarket(f, then) {
  if (!f.autoload || MARKET || feeMarketPending) return;
  feeMarketPending = true;
  loadMarket()
    .then(() => { feeMarketPending = false; setupEnRoute(); then(); })
    .catch(() => { feeMarketPending = false; marketUnavailable(); });
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
  MARKET.terminals.forEach((t) => termByName.set(t.name, t)); // pont nom -> terminal (frais d'autoload)
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

// `m` = manifeste courant (il porte `fee`, le contexte de frais qui l'a produit) ; `t` = ses totaux.
function manifestTotalsHTML(m, t) {
  const empty = m.cargo - t.scu;
  const profitHour = (t.profit * 60) / tripMinutes(0, m.cross);
  // Les frais sont exposés à part plutôt que fondus dans le profit : c'est le seul moyen de voir
  // ce que coûte la manutention d'un chargement à plusieurs commodités (une base par ligne).
  const fees = t.fees > 0 ? ` · <span class="fee-chip" title="${m.feeInfo ? esc(`${feeEndText(m.feeInfo.a)} · ${feeEndText(m.feeInfo.b)} · une transaction par commodité · estimation ±3 %`) : ""}">frais ≈ ${fmt(t.fees)}</span>` : "";
  // `m.aBord` : la soute n'était pas vide, le manifeste ne remplit donc que la place restante.
  // Le dire ici évite de lire « 47/47 SCU » sur un vaisseau de 96 sans comprendre pourquoi.
  const bord = m.aBord > 0 ? ` · <span class="mbord" title="Déjà en soute, payé — cf. panneau Soute">${fmt(m.aBord)} SCU à bord</span>` : "";
  return `Profit <b class="profit">${fmtFee(t.profit, t.fees)}</b> aUEC${fees} · <b>${fmt(t.scu)}</b>/${fmt(m.cargo)} SCU${bord}${empty > 0 ? ` · ${fmt(empty)} SCU vides` : ""} · invest. ${fmt(t.invest)} · ~${fmtFee(profitHour, t.fees)}/h`;
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
// Le calcul vit dans logic.mjs (partagé avec le manifeste optimal, donc éligibilité identique) ;
// app.js ne fournit que le marché et le résolveur de corrections.
const suggestionsFor = (m = currentManifest) => suggestionsFrom(MARKET, m, effVals);

// addableUnits vient de logic.mjs.

// HTML des suggestions de remplissage pour un contexte de manifeste (En route ou jambe de voyage).
// `addAttrs` = attributs data-* posés sur le bouton d'ajout, propres à l'appelant.
function suggestionsHTML(m, addAttrs = "") {
  const rem = manifestRemaining(m);
  if (rem.cargoLeft <= 0) return "";
  const sugg = suggestionsFor(m).map((it) => ({ it, u: addableUnits(it, rem) })).filter((x) => x.u >= 1)
    // Frais actifs : une commodité dont la manutention mange la marge fait PERDRE de l'argent, et
    // le manifeste optimal l'écarte déjà (manifestsFrom). La proposer en tête, juste sous le
    // manifeste qui vient de la refuser, serait une contradiction à l'écran.
    .filter((x) => !m.fee || lineNet(x.u, x.it, m.fee) > 0)
    .slice(0, 6);
  if (!sugg.length) return `<div class="suggest-head">${fmt(rem.cargoLeft)} SCU libres — aucune autre commodité rentable vers cette destination.</div>`;
  return `<div class="suggest-head">Remplir les ${fmt(rem.cargoLeft)} SCU libres — suggestions :</div>` +
    sugg.map(({ it, u }) =>
      `<div class="sline">${commodityIcon(it.kind)}` +
      `<span class="mname">${esc(it.name)}${illegalTag(it.illegal)}</span>` +
      `<span class="mstock">stock ${fmt(it.stock)} · dem. ${fmtVol(it.demand)}</span>` +
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

// Trouve une commodité par nom OU code (insensible à la casse/espaces). Partagé par les ajouts
// libres. La résolution vit dans logic.mjs : un code UEX peut désigner deux commodités.
const findCommodity = (name) => resolveCommodity(MARKET.commodities, name);

// Ajout LIBRE : n'importe quelle commodité (par nom ou code), même si elle n'est pas vendable à
// destination — on la charge pour l'écouler ailleurs (ligne « carry-only », marge nulle ici).
function addManifestCommodity(name) {
  const m = currentManifest;
  if (!m || !MARKET) return;
  const c = findCommodity(name);
  if (!c || m.lines.some((l) => l.name === c.name)) return; // inconnue ou déjà dans le manifeste
  m.lines.push(freeManifestLine(MARKET, m.originIdx, m.destIdx, c, manifestRemaining().cargoLeft, effVals));
  paintManifest();
}

// Retire une ligne du manifeste (par nom de commodité).
function removeManifestLine(name) {
  const m = currentManifest;
  if (!m) return;
  m.lines = m.lines.filter((l) => l.name !== name);
  paintManifest();
}

// Engager le chargement dans le voyage : le bouton, ou la phrase qui dit pourquoi il n'y est pas.
// L'état vient de manifestJourneyState (pur, testé) — le rendu ne décide de rien.
// Le bouton n'existe QUE dans l'état « ajouter », donc la branche REMPLACER d'addToJourney, qui
// efface un voyage sans prévenir, est inatteignable depuis cette carte.
function manifestJourneyHTML(m) {
  if (!m.lines.length) return `<span class="journey-hint">Manifeste vide — ajoute une commodité pour l'engager.</span>`;
  const st = manifestJourneyState(JOURNEY, m.origin, m.dest);
  if (st.etat === "ajouter") {
    const neuf = !JOURNEY;
    return `<button id="manifestToJourney" class="chain-pick" title="${neuf ? "Démarrer un voyage avec ce chargement" : "Ajouter ce chargement à la suite du voyage"}">▶ ${neuf ? "Démarrer un voyage" : "Ajouter au voyage"}</button>`;
  }
  // « Déjà » est l'état NORMAL après tout ▶ (En route est pré-rempli avec la jambe courante) et
  // celui où l'on retombe après un ajout réussi : la phrase fait donc office de confirmation, à
  // l'endroit exact du clic. Un bouton y serait un clic mort.
  if (st.etat === "deja") return `<span class="journey-hint">✓ C'est déjà la jambe ${st.leg + 1} de ton voyage.</span>`;
  if (!st.fin) return "";
  return `<span class="journey-hint">Ce chargement part de <b>${esc(m.origin.name)}</b>, mais le voyage se termine à <b>${esc(st.fin)}</b> — seul un chargement au départ de <b>${esc(st.fin)}</b> s'y ajoute.</span>`;
}

// Dessine le manifeste courant : totaux + lignes (SCU/prix/stock éditables) + suggestions.
function paintManifest() {
  const m = currentManifest;
  const card = $("manifest");
  const totals = manifestTotals(m.lines, m.fee);
  card.hidden = false;
  card.innerHTML =
    `<div class="manifest-head">
      <span class="manifest-title">◈ Manifeste — ${esc(m.origin.name)}${sysBadge(m.origin.system)} → ${esc(m.dest.name)}${sysBadge(m.dest.system)}${m.cross ? ' <span class="cross">⚡ inter-système</span>' : ""}</span>
      <span class="manifest-tot" id="manifestTot">${manifestTotalsHTML(m, totals)}</span>
      ${manifestJourneyHTML(m)}
      <button id="copyManifest" class="copy-btn" title="Copier le plan de chargement">⧉ Copier</button>
    </div>
    <div class="manifest-lines">` +
    m.lines.map((l, i) => {
      const carry = l.sellPrice == null; // pas vendable à cette destination -> à écouler ailleurs
      // Symétrique : aucun point d'achat au départ -> le fret est DÉJÀ en soute (butin, minage,
      // salvage). Afficher un prix « 0 » éditable le ferait passer pour un achat gratuit sur place.
      const acq = !!l.acquired;
      const demCell = carry ? '<span class="muted">—</span>' : editv(l.name, m.dest.name, "sell", "vol", l.demand, isOv(l.name, m.dest.name, "sell", "vol"), l.sellUpdated);
      const sellCell = carry ? '<span class="carry-tag" title="Pas vendable à cette destination — à écouler ailleurs">vend ailleurs</span>' : editv(l.name, m.dest.name, "sell", "price", l.sellPrice, isOv(l.name, m.dest.name, "sell", "price"), l.sellUpdated);
      const stockCell = acq ? '<span class="muted">—</span>' : editv(l.name, m.origin.name, "buy", "vol", l.stock, isOv(l.name, m.origin.name, "buy", "vol"), l.buyUpdated);
      const buyCell = acq ? '<span class="carry-tag" title="Introuvable à l\'achat ici — fret déjà en soute (butin, minage, salvage). Ajuste les SCU à ce que tu transportes.">acquis ailleurs</span>' : editv(l.name, m.origin.name, "buy", "price", l.buyPrice, isOv(l.name, m.origin.name, "buy", "price"), l.buyUpdated);
      const lineFees = lineHaulFee(l.units, l, m.fee);
      // Une ligne « vend ailleurs » n'a pas de profit ICI (elle sera écoulée plus loin), mais elle
      // a bien été CHARGÉE ici : ses frais sont retranchés du total. Les taire laissait le total
      // baisser sans qu'aucune ligne à l'écran ne l'explique.
      const profitCell = carry
        ? `<span class="mprofit muted"${lineFees > 0 ? ' title="Chargée ici, vendue ailleurs : seul le chargement est facturé sur ce trajet"' : ""}>${lineProfitText(l.units, l, m.fee)}</span>`
        : `<span class="mprofit profit">${lineProfitText(l.units, l, m.fee)}</span>`;
      return `<div class="mline${carry ? " carry" : ""}${acq ? " acquired" : ""}">${commodityIcon(l.kind)}` +
        `<span class="mqtywrap"><input type="number" class="mqty-input" min="0" value="${l.units}" data-i="${i}" data-cap="${l.cap}" title="Ajuste librement — tu peux dépasser le stock UEX (vol de fret, relevé périmé…)" aria-label="SCU ${esc(l.name)}"><span class="munit">SCU</span></span>` +
        `<span class="mname">${esc(l.name)}${illegalTag(l.illegal)}<button class="mline-del" data-name="${esc(l.name)}" title="Retirer du manifeste" aria-label="Retirer">✕</button></span>` +
        `<span class="mstock">stock ${stockCell} · dem. ${demCell}</span>` +
        `<span class="mprice">${buyCell} → ${sellCell}</span>` +
        profitCell +
        `<span class="mboxes" title="Caisses SCU standard à charger">📦 ${scuBoxesLabel(l.units, m.origin.maxBox)}</span></div>`;
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
  const pair = currentManifest.fee;
  document.querySelectorAll("#manifest .mqty-input").forEach((inp) => {
    const i = Number(inp.dataset.i);
    const cap = Number(inp.dataset.cap);
    let u = Math.floor(Number(inp.value));
    if (!Number.isFinite(u) || u < 0) u = 0;
    // Le dépassement du stock UEX est autorisé (vol de fret, relevé périmé…) : on ne plafonne
    // plus à `cap`, on le signale visuellement pour que ce soit un choix conscient.
    inp.classList.toggle("over-stock", u > cap);
    // La LIGNE, pas ses attributs data-* : elle seule porte `carry`/`acquired`, donc le nombre
    // d'opérations réellement facturées. Recalculer à partir de la seule marge affichait un profit
    // qui contredisait le total juste au-dessus.
    const l = currentManifest.lines[i];
    if (!l) return;
    l.units = u;
    const line = inp.closest(".mline");
    line.querySelector(".mprofit").textContent = lineProfitText(u, l, pair);
    line.querySelector(".mboxes").textContent = "📦 " + scuBoxesLabel(u, currentManifest.origin.maxBox);
  });
  const totals = manifestTotals(currentManifest.lines, pair); // unités déjà synchronisées ci-dessus
  $("manifestTot").innerHTML = manifestTotalsHTML(currentManifest, totals);
  renderSuggestions();
}

// Copie le plan de chargement en texte (pour un 2e écran / des notes).
function copyManifest() {
  const m = currentManifest;
  if (!m) return;
  const { profit, invest, scu, fees } = manifestTotals(m.lines, m.fee);
  const rows = m.lines.map(
    (l) => `${fmt(l.units)} SCU  ${l.name}  @ ${fmt(l.buyPrice)} -> ${fmt(l.sellPrice)}  (${lineProfitText(l.units, l, m.fee)} aUEC)  [${scuBoxesLabel(l.units, m.origin.maxBox)}]`
  );
  const text = [
    `Manifeste — ${m.origin.name} (${m.origin.system}) -> ${m.dest.name} (${m.dest.system})`,
    ...rows,
    `Total : ${fmt(scu)}/${fmt(m.cargo)} SCU · profit ${fmtFee(profit, fees)} aUEC · investissement ${fmt(invest)} aUEC` +
      (fees > 0 ? ` · frais d'autoload ≈ ${fmt(fees)} aUEC (estimation)` : ""),
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
  // La soute n'est pas vide : on ne peut charger QUE la place qui reste. C'est la question du
  // scénario d'ADR-002 — « j'ai 30 SCU de libre, qu'est-ce que j'y mets maintenant ? ». Les autres
  // vues gardent la soute nominale : elles répondent à « quelle est la meilleure route », pas à
  // « que puis-je embarquer là, tout de suite ».
  const aBord = holdScu(SOUTE);
  const libre = freeCargo(SOUTE, f.cargo);
  if (aBord > 0 && libre <= 0) {
    card.hidden = false;
    card.innerHTML = `<div class="manifest-hint">Soute pleine : <b>${fmt(aBord)} SCU</b> déjà à bord. Vends ou dépose du fret pour charger autre chose.</div>`;
    return;
  }
  const fLibre = aBord > 0 ? { ...f, cargo: libre } : f;
  const man = bestManifest(MARKET, origin, destSystem, fLibre, effVals, destTerminal, feeResolver(f));
  if (!man) {
    card.hidden = false;
    card.innerHTML = `<div class="manifest-hint">Aucun chargement rentable depuis ce terminal vers cette destination${aBord > 0 ? ` dans les <b>${fmt(libre)} SCU</b> qui restent libres` : ""}.</div>`;
    return;
  }
  man.originIdx = origin;
  man.f = fLibre;
  man.aBord = aBord; // pour que la carte dise pourquoi elle ne remplit que ça
  // `man.fee` (le contexte de frais) vient de manifestsFrom : on ne le reconstruit pas, on ne
  // risque donc pas de le reconstruire AUTREMENT que ce qui a servi à choisir la destination.
  man.feeInfo = feeCtx(f, man.origin.name, man.dest.name, man.origin, man.dest);
  currentManifest = man;
  paintManifest();
}

function renderEnRoute() {
  if (!MARKET) { withMarket(refresh); return; }
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
  // Le contexte de frais descend DANS enRouteDeals : elle ne garde qu'UNE vente par commodité, donc
  // une destination meilleure en net n'entrerait jamais dans la liste — et la carte Manifeste, juste
  // au-dessus, afficherait la destination inverse (bestManifest, lui, tranche déjà sur le net).
  let deals = enRouteDeals(MARKET, enrouteOrigin, destSystem, enrouteDest, f, feeResolver(f))
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

function chainCardHTML(chain, f) {
  const T = (idx) => MARKET.terminals[idx];
  const invest = chain.legs[0] ? chain.legs[0].units * chain.legs[0].buyPrice : 0;
  let minutes = 0;
  for (let i = 0; i < chain.legs.length; i++) {
    minutes += tripMinutes(0, T(chain.path[i]).system !== T(chain.path[i + 1]).system);
  }
  // Deux opérations par saut. bestChain a déjà retranché ces frais (il les reçoit par `leg.fee`) :
  // on ne fait ici que les rendre lisibles, jamais les recalculer autrement.
  const totalFees = chain.legs.reduce((s, leg) => s + haulFee(leg.units, leg.fee), 0);
  const nodes = chain.path
    .map((idx) => `<span class="snode term">${esc(T(idx).name)}</span>${sysBadge(T(idx).system)}`)
    .join('<span class="chain-arrow">→</span>');
  const legs = chain.legs
    .map((leg, i) => {
      const a = T(chain.path[i]), b = T(chain.path[i + 1]);
      const fees = haulFee(leg.units, leg.fee);
      const fc = feeCell(feeCtx(f, a.name, b.name, a, b), fees, () => feeLoadText(leg.units, a.maxBox), leg.units > 0);
      return `<div class="chain-leg"><span class="chain-step">${i + 1}</span><div class="chain-leg-main">` +
        `<div class="commodity-cell">${commodityIcon(leg.kind)}<span><b>${esc(leg.commodity)}</b>${illegalTag(leg.illegal)} · ${fmt(leg.units)} SCU</span></div>` +
        `<div class="loc-sub">${esc(a.name)} → ${esc(b.name)} · ${fmt(leg.buyPrice)} → ${fmt(leg.sellPrice)} (marge ${fmt(leg.margin)}/SCU)</div>` +
        `</div><span class="chain-leg-profit profit"${fc.attr}>+${fmtFee(leg.profit, fees)}${fc.mark}</span></div>`;
    })
    .join("");
  return `<div class="chain">
      <div class="chain-head">
        <span class="chain-path">${nodes}</span>
        <span class="chain-tot">Profit <b class="profit">${fmtFee(chain.profit, totalFees)}</b> aUEC${totalFees > 0 ? ` · frais ≈ ${fmt(totalFees)}` : ""} · ${chain.legs.length} saut${chain.legs.length > 1 ? "s" : ""} · capital de départ ${fmt(invest)} · ~${Math.round(minutes)} min</span>
        <button id="chainToJourney" class="chain-pick" title="Ajouter cette chaîne au voyage en cours">▶ Ajouter au voyage</button>
      </div>
      <div class="chain-legs">${legs}</div>
    </div>`;
}

function renderChain() {
  if (!MARKET) { withMarket(refresh); return; }
  if (!enrouteReady) setupEnRoute();
  resolveChainOrigin();
  const box = $("chainOut");
  const f = readFilters();
  shownChain = null;
  const hint = (msg) => { box.innerHTML = `<div class="manifest-hint">${msg}</div>`; notifySuperseded(); };
  if (chainOrigin == null) return hint("Choisis un <b>terminal de départ</b> pour calculer une chaîne rentable.");
  if (!f.useCargo || !(f.cargo > 0)) return hint("Active la <b>soute (SCU)</b> pour dimensionner la chaîne.");
  const hops = Number($("hops").value) || 3;
  // Les frais sont estampillés sur chaque leg par buildChainAdjacency — seul endroit de la chaîne
  // où les deux terminaux d'un saut coexistent — puis consommés par bestChain, dont l'élagage et la
  // sélection portent alors sur le profit NET.
  const chain = bestChain(buildChainAdjacency(MARKET, f, effVals, feeResolver(f)), chainOrigin, hops, { cargo: f.cargo });
  if (!chain || !chain.legs.length) return hint("Aucune chaîne rentable depuis ce terminal avec ces filtres.");
  shownChain = chain;
  box.innerHTML = chainCardHTML(chain, f);
  notifySuperseded();
}

// ---------- La soute : ce qui est à bord, et ce qu'on l'a payé (ADR-002) ----------
// Un lot par chargement — la même commodité peut y figurer deux fois à des prix différents.
// PERSISTÉE ET SANS PÉREMPTION : reprendre le jeu une semaine plus tard avec un vaisseau rangé
// plein, ce n'est pas une soute périmée, c'est une soute exacte. C'est aussi pour ça qu'effacer le
// voyage NE VIDE PAS la soute : le parcours est un plan, la soute est du fret réel.
const HOLD_KEY = "best-hauling-hold";
let SOUTE = [];
function loadSoute() {
  try { SOUTE = JSON.parse(localStorage.getItem(HOLD_KEY)) || []; } catch { SOUTE = []; }
  if (!Array.isArray(SOUTE)) SOUTE = [];
}
function saveSoute() { try { localStorage.setItem(HOLD_KEY, JSON.stringify(SOUTE)); } catch {} }

// Charge le manifeste d'une jambe dans la soute, au prix que l'app venait d'afficher. Les lots
// portent la clé de la jambe : c'est ce qui permet d'annuler un chargement sans deviner.
// Le point d'achat d'une commodité à un terminal, avec son stock EFFECTIF (corrections comprises)
// et la date UEX qui sert d'ancre à toute correction locale.
function pointAchat(nomCommodite, nomTerminal) {
  const c = MARKET && findCommodity(nomCommodite);
  const idx = stationMap.size ? [...stationMap].find(([lab]) => parseStationLabel(lab).name === nomTerminal) : null;
  if (!c || !idx) return null;
  const b = c.buys.find((x) => x[0] === idx[1]);
  if (!b) return null;
  const e = effVals(c.name, nomTerminal, "buy", b[1], b[2], b[3]);
  return { commodite: c.name, stock: e.vol, base: b[3] };
}

function chargerJambe(i) {
  const leg = JOURNEY && JOURNEY.legs[i];
  if (!leg || !MARKET) return;
  const k = legKey(leg, i);
  if (SOUTE.some((l) => l.leg === k)) {
    // Annulation : on rend à la station ce qu'on lui avait retiré. La valeur d'AVANT est portée par
    // le lot, donc on restaure exactement — et non « stock + units », qui gonflerait un rayon qu'on
    // avait vidé au-delà de ce qu'il annonçait.
    for (const l of SOUTE.filter((x) => x.leg === k && x.avant != null)) {
      const p = pointAchat(l.name, l.from);
      if (p) setOverride(l.name, l.from, "buy", "vol", l.avant, p.base);
    }
    SOUTE = SOUTE.filter((l) => l.leg !== k);
    updateOvBadge();
  } else {
    const lignes = legEffectiveLines(leg, i, readFilters());
    if (!lignes.length) return;
    const lots = loadHold([], lignes, leg.from, nowSec()).map((l) => ({ ...l, leg: k }));
    // Charger, c'est vider le rayon d'autant. On fige d'abord les jambes qui achetaient ce point
    // (même règle qu'une correction de volume saisie à la main), puis on écrit la déduction.
    const vides = [];
    for (const l of lots) {
      const p = pointAchat(l.name, l.from);
      if (!p || p.stock == null) continue;
      l.avant = p.stock;
      pinLegsForVolume(l.name, l.from, "buy");
      const reste = stockApres(p.stock, l.units);
      setOverride(l.name, l.from, "buy", "vol", reste, p.base);
      if (p.stock < l.units) vides.push(l.name); // le relevé annonçait moins que ce qu'on a pris
    }
    SOUTE = SOUTE.concat(lots);
    updateOvBadge();
    if (vides.length) {
      showToast(`✓ Chargé — stock mis à 0 pour ${vides.join(", ")} : le relevé UEX en annonçait moins que ce que tu as pris`);
    }
  }
  saveSoute();
  renderJourney();
  refresh();
}
const jambeChargee = (leg, i) => SOUTE.some((l) => l.leg === legKey(leg, i));

// « Où suis-je ? » — l'étape courante du voyage, ou à défaut le terminal de départ d'« En route ».
// C'est ce terminal qui fixe le prix d'une vente et qui porte le marqueur « refusé ici ».
function stationCourante() {
  if (JOURNEY) {
    const ici = journeyStations(JOURNEY)[JOURNEY.current];
    if (ici) return stationMap.get(stationLabel(ici.name, ici.system));
  }
  return enrouteOrigin; // peut être null : la vente est alors impossible, et le bouton absent
}

// Vend `units` SCU ici. Si le comptoir n'a pas tout pris, le reste est marqué REFUSÉ à cette
// station : il traversera la vente implicite du départ sans être effacé.
function vendreIci(nom, units) {
  const idx = stationCourante();
  if (idx == null || !MARKET) return;
  const pt = sellableAt(MARKET, idx, nom, effVals);
  if (!pt) return;
  const avant = SOUTE.reduce((s, l) => s + (l.name === nom ? l.units || 0 : 0), 0);
  const r = sellFromHold(SOUTE, nom, units, pt.price);
  if (!r.vendu) return;
  SOUTE = r.vendu < avant ? refuseHere(r.hold, nom, pt.terminal) : r.hold;
  saveSoute();
  venteEnCours = null;
  renderSoute(); refresh();
  const reste = avant - r.vendu;
  showToast(`✓ ${fmt(r.vendu)} SCU de ${nom} vendus — ${fmtSigne(r.profit)} aUEC` +
    (reste > 0 ? ` · ${fmt(reste)} SCU restent à bord (refusés ici)` : ""));
}

// Quitter une escale sous-entend qu'on y a fait son affaire : ce qu'elle reprend est vendu.
// Ce qu'une vente partielle y a laissé porte `refuse` et traverse intact.
function venteImplicite(depuis) {
  if (!SOUTE.length || !MARKET || depuis == null) return;
  const r = sellAllAt(SOUTE, MARKET, depuis, effVals);
  if (!r.ventes.length) return;
  SOUTE = r.hold;
  saveSoute();
  const quoi = r.ventes.map((v) => `${fmt(v.units)} ${v.name}`).join(", ");
  showToast(`✓ Vendu en quittant ${MARKET.terminals[depuis].name} : ${quoi} — ${fmtSigne(r.profit)} aUEC`);
}

const fmtSigne = (n) => (n >= 0 ? "+" : "") + fmt(Math.round(n));
let venteEnCours = null; // commodité dont le champ « vendu » est ouvert

// Le fret déposé à une station : ni vendu, ni perdu — du capital immobilisé qu'on peut oublier.
const DEPOTS_KEY = "best-hauling-depots";
let DEPOTS = {};
function loadDepots() {
  try { DEPOTS = JSON.parse(localStorage.getItem(DEPOTS_KEY)) || {}; } catch { DEPOTS = {}; }
}
function saveDepots() { try { localStorage.setItem(DEPOTS_KEY, JSON.stringify(DEPOTS)); } catch {} }

function deposerIci(nom, units) {
  const idx = stationCourante();
  if (idx == null || !MARKET) return;
  const t = MARKET.terminals[idx];
  const r = storeFromHold(SOUTE, DEPOTS, nom, units, stationLabel(t.name, t.system));
  if (r.hold === SOUTE) return;
  SOUTE = r.hold; DEPOTS = r.entrepots;
  saveSoute(); saveDepots();
  venteEnCours = null;
  renderSoute(); refresh();
  showToast(`⬓ ${fmt(units)} SCU de ${nom} déposés à ${t.name} — ni vendus ni perdus`);
}

// « Où écouler ce qui reste ? » — le détour manuel par la vue Commodités, en un panneau.
let ecoulerOuvert = false;
function ecoulerHTML() {
  const idx = stationCourante();
  if (!ecoulerOuvert || idx == null || !MARKET) return "";
  const f = readFilters();
  const dest = offloadPlan(MARKET, SOUTE, idx, f, effVals, feeResolver(f), 5);
  if (!dest.length) {
    return `<div class="hold-ecouler"><p class="muted">Aucune destination ne reprend ce fret avec ces filtres.
      Tu peux le <b>déposer</b> à une station : il n'est alors ni vendu ni perdu.</p></div>`;
  }
  const lignes = dest.map((d) => {
    const cert = d.certitude === "connue"
      ? `<span class="ec-sur" title="Capacité publiée par UEX">${fmt(d.garanti)} SCU garantis</span>`
      : d.certitude === "inconnue"
        ? `<span class="ec-flou" title="UEX ne publie pas la capacité de ce point : ni zéro, ni illimitée">capacité inconnue</span>`
        : `<span class="ec-flou" title="Capacité publiée pour une partie seulement">${fmt(d.garanti)} SCU garantis, reste inconnu</span>`;
    const detail = d.lignes.map((l) => `${esc(l.name)} ${fmt(l.absorbe)}${l.reste > 0 ? `/${fmt(l.absorbe + l.reste)}` : ""}`).join(" · ");
    // Vendre sous le prix payé peut rester le bon choix — libérer la soute vaut parfois une perte —
    // mais ça ne doit jamais passer inaperçu derrière un chiffre positif.
    const perte = d.aPerte ? ` · <span class="ec-perte" title="Le prix ici est inférieur à ce que tu as payé">sous le prix payé</span>` : "";
    return `<div class="ec-dest">
        <span class="ec-nom">${esc(d.terminal)}${sysBadge(d.system)}${d.cross ? ' <span class="cross">⚡</span>' : ""}${outpostTag(d.outpost)}</span>
        <span class="ec-profit profit" title="Ce qui rentre : recette nette des frais. Le prix d'achat est déjà payé — il ne dépend plus d'aucune décision.">+${fmt(Math.round(d.encaisse))}</span>
        <span class="ec-detail">${esc(detail)} · ${cert}${perte}${d.reste > 0 ? ` · <b>${fmt(d.reste)}</b> SCU resteraient à bord` : " · <b>soute vidée</b>"}</span>
      </div>`;
  }).join("");
  return `<div class="hold-ecouler"><div class="ec-head">Où écouler — classé par ce qui rentre (le prix d'achat est déjà payé)</div>${lignes}</div>`;
}

function viderSoute() { SOUTE = []; saveSoute(); renderSoute(); refresh(); }
function retirerLot(i) { SOUTE = SOUTE.filter((_, j) => j !== i); saveSoute(); renderSoute(); refresh(); }

function renderSoute() {
  const box = $("holdCard");
  if (!box) return;
  if (!SOUTE.length) { box.hidden = true; return; }
  box.hidden = false;
  const groupes = holdByCommodity(SOUTE);
  const ici = stationCourante();
  const scu = holdScu(SOUTE);
  const f = readFilters();
  const libre = f.useCargo && f.cargo > 0 ? freeCargo(SOUTE, f.cargo) : null;
  const invest = groupes.reduce((s, g) => s + g.invest, 0);
  // Le `kind` n'est pas persisté dans le lot : c'est une propriété de la commodité, pas de la
  // transaction. On le relit au marché quand il est là, et on s'en passe sinon.
  const icone = (nom) => {
    const c = MARKET && findCommodity(nom);
    return c ? commodityIcon(c.kind) : "";
  };
  const lignes = groupes.map((g) => {
    // Le détail des lots n'apparaît que s'il y en a plusieurs : sinon c'est du bruit.
    const lots = g.lots.length > 1
      ? `<div class="hold-lots">${g.lots.map((l) => `<span class="hold-lot" title="Chargé à ${esc(l.from || "?")}">${fmt(l.units)} SCU @ ${fmt(l.paid)}<button class="hold-del" data-i="${l.i}" title="Retirer ce lot" aria-label="Retirer">✕</button></span>`).join("")}</div>`
      : `<button class="hold-del solo" data-i="${g.lots[0].i}" title="Retirer ce lot" aria-label="Retirer">✕</button>`;
    // Vendre suppose de savoir OÙ l'on est, et que le comptoir reprenne la commodité.
    const pt = ici != null && MARKET ? sellableAt(MARKET, ici, g.name, effVals) : null;
    // Vendre suppose que le comptoir reprenne la commodité ; DÉPOSER, non — c'est justement la
    // sortie quand il n'en veut pas. Les deux ouvrent le même champ de quantité.
    const vente = venteEnCours === g.name
      ? `<span class="hold-sell open"><input class="hold-sell-qty" type="number" min="0" max="${g.units}" value="${g.units}" aria-label="SCU de ${esc(g.name)}" />
           ${pt ? `<button class="hold-sell-ok" data-name="${esc(g.name)}" title="Vendre ici à ${fmt(pt.price)} aUEC/SCU">✓ vendre</button>` : ""}
           <button class="hold-store" data-name="${esc(g.name)}" title="Déposer à la station : ni vendu, ni perdu">⬓ déposer</button>
           <button class="hold-sell-no" title="Annuler">✕</button></span>`
      : ici != null
        ? `<button class="hold-sell-btn" data-name="${esc(g.name)}" title="${pt
            ? `Vendre ou déposer ici — ${fmt(pt.price)} aUEC/SCU${pt.demand == null ? ", capacité inconnue chez UEX" : `, capacité annoncée ${fmt(pt.demand)} SCU`}`
            : "Ce comptoir ne reprend pas cette commodité — tu peux quand même l'y déposer"}">${pt ? "vendu" : "déposer"}</button>`
        : "";
    return `<div class="hold-line">
        <span class="hold-name">${icone(g.name)}${esc(g.name)}</span>
        <span class="hold-scu"><b>${fmt(g.units)}</b> SCU</span>
        <span class="hold-paid" title="Prix payé au SCU${g.lots.length > 1 ? " (moyenne des lots)" : ""}">@ ${fmt(Math.round(g.paidMoyen))}</span>
        ${vente}
        ${lots}
      </div>`;
  }).join("");
  box.innerHTML =
    `<div class="hold-head"><span class="hold-title">◈ Soute</span><button id="holdClear" class="journey-clear" title="Vider la soute (le fret est débarqué)" aria-label="Vider la soute">✕</button></div>
     <div class="hold-lines">${lignes}</div>
     <div class="hold-meta"><b>${fmt(scu)}</b> SCU à bord${libre != null ? ` · <b>${fmt(libre)}</b> libres` : ""} · capital engagé <b>${fmt(invest)}</b> aUEC
       <button id="holdOffload" class="hold-offload">${ecoulerOuvert ? "▾" : "▸"} où écouler ?</button></div>
     ${ecoulerHTML()}`;
}

// ---------- Carte 2D du parcours (ADR-001) ----------
// Le calcul est PUR (journeyMap, logic.mjs) : ici on n'émet que du SVG. Aucun asset, aucune image.

// Semis d'étoiles déterministe (générateur congruentiel) : même ciel à chaque rendu, donc aucun
// scintillement quand la carte se redessine — et statique, décision de l'ADR : rien ne doit bouger
// en périphérie de tableaux qu'on lit.
function etoilesHTML(n, w, h) {
  let s = 20260812, out = "";
  const suivant = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) {
    const x = (suivant() * w).toFixed(1), y = (suivant() * h).toFixed(1), o = (0.12 + suivant() * 0.45).toFixed(2);
    out += `<circle cx="${x}" cy="${y}" r="${suivant() > 0.9 ? 0.9 : 0.5}" fill="#dfe6f5" opacity="${o}"/>`;
  }
  return out;
}

const SYS_TEINTE = { Stanton: "var(--stanton)", Pyro: "var(--pyro)", Nyx: "var(--nyx)" };
const teinte = (nom) => SYS_TEINTE[nom] || "var(--acc)";

function journeyMapHTML(c) {
  const nf = (v) => Number(v).toFixed(1);
  let svg = `<rect width="${c.largeur}" height="${c.hauteur}" fill="#080b14"/>${etoilesHTML(70, c.largeur, c.hauteur)}`;

  for (const sys of c.systemes) {
    const t = teinte(sys.nom);
    svg += `<g class="jm-sys"><circle cx="${nf(sys.cx)}" cy="${nf(sys.cy)}" r="${nf(sys.r * 1.1)}" fill="none" stroke="${t}" stroke-opacity="0.13" stroke-dasharray="2 5"/>`;
    for (const b of sys.corps) {
      svg += `<circle cx="${nf(sys.cx)}" cy="${nf(sys.cy)}" r="${nf(b.orbite)}" fill="none" stroke="${t}" stroke-opacity="0.15"/>`;
      svg += `<circle cx="${nf(b.x)}" cy="${nf(b.y)}" r="3.2" fill="${t}" fill-opacity="0.85"/>`;
      // Le libellé du corps s'efface quand une escale s'y pose : son nom est déjà écrit là.
      if (!b.occupe) svg += `<text class="jm-corps" x="${nf(b.x + 6)}" y="${nf(b.y + 3)}">${esc(b.nom)}</text>`;
    }
    svg += `<circle cx="${nf(sys.cx)}" cy="${nf(sys.cy)}" r="6.5" fill="${t}" fill-opacity="0.18"/>`;
    svg += `<circle cx="${nf(sys.cx)}" cy="${nf(sys.cy)}" r="3" fill="${t}"/>`;
    svg += `<text class="jm-sysnom" x="${nf(sys.cx)}" y="${nf(Math.max(13, sys.cy - sys.r * 1.22))}" fill="${t}">${esc(sys.nom.toUpperCase())}</text></g>`;
  }

  for (const j of c.jambes) {
    svg += j.saut
      ? `<path class="jm-saut" d="M${nf(j.x1)} ${nf(j.y1)} L${nf(j.x2)} ${nf(j.y2)}"/>` +
        `<circle class="jm-saut-noeud" cx="${nf((j.x1 + j.x2) / 2)}" cy="${nf((j.y1 + j.y2) / 2)}" r="7"/>` +
        `<text class="jm-saut-glyphe" x="${nf((j.x1 + j.x2) / 2)}" y="${nf((j.y1 + j.y2) / 2 + 3)}">⚡</text>`
      : `<path class="jm-jambe${j.faite ? " faite" : ""}" d="M${nf(j.x1)} ${nf(j.y1)} L${nf(j.x2)} ${nf(j.y2)}"/>`;
  }

  // Les arrêts sont des boutons : cliquer une escale déplace « je suis ici », comme le fil
  // d'étapes textuel juste au-dessus (décision de l'ADR — un second chemin, pas une nouveauté).
  c.arrets.forEach((a, i) => {
    const fait = i < c.vaisseau.arret, ici = i === c.vaisseau.arret;
    const droite = a.x < c.largeur / 2;
    svg += `<g class="jm-arret${fait ? " fait" : ""}${ici ? " ici" : ""}" data-i="${i}" role="button" tabindex="0" aria-label="Se placer à ${esc(a.nom)}">` +
      `<circle class="jm-cible" cx="${nf(a.x)}" cy="${nf(a.y)}" r="11"/>` +
      `<circle class="jm-point" cx="${nf(a.x)}" cy="${nf(a.y)}" r="4.5"/>` +
      `<text class="jm-nom" x="${nf(a.x + (droite ? 9 : -9))}" y="${nf(a.y - 9)}" text-anchor="${droite ? "start" : "end"}">${esc(a.nom)}</text></g>`;
  });

  const v = c.vaisseau;
  svg += `<g class="jm-vaisseau${v.enVol ? " en-vol" : ""}" style="transform: translate(${nf(v.x)}px, ${nf(v.y)}px) rotate(${nf(v.angle)}deg)">` +
    `<circle r="10" fill="var(--acc)" fill-opacity="0.12"/><path d="M8 0 L-5 5 L-2.5 0 L-5 -5 Z" fill="var(--acc)" stroke="#140c00" stroke-width="0.5"/></g>`;

  return `<svg class="jm-svg" viewBox="0 0 ${c.largeur} ${c.hauteur}" role="img" aria-label="Carte du parcours : ${esc(c.arrets.map((a) => a.nom).join(", puis "))}">${svg}</svg>`;
}

// Dessine (ou masque) le panneau carte. Appelé par renderJourney, donc à chaque refresh.
function renderJourneyMap() {
  const box = $("journeyMap");
  if (!box) return;
  if (!JOURNEY || !MARKET) { box.hidden = true; return; }
  if (!STARMAP) { ensureStarmap(renderJourneyMap); box.hidden = true; return; }
  const info = (nom) => {
    const i = stationMap.get(stationLabel(nom, (journeyStations(JOURNEY).find((s) => s.name === nom) || {}).system || ""));
    return i == null ? null : MARKET.terminals[i];
  };
  // Jambe courante chargée = on a payé et on est parti : le vaisseau quitte le quai sur la carte.
  const legCourante = JOURNEY.legs[JOURNEY.current];
  const enVol = !!legCourante && jambeChargee(legCourante, JOURNEY.current);
  const c = journeyMap(journeyStations(JOURNEY), JOURNEY.current, STARMAP, info, enVol);
  if (!c) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<span class="jm-label">◈ <b>Carte du parcours</b> <span class="muted">schéma — rayons compressés</span></span>${journeyMapHTML(c)}`;
}

// ---------- Compagnon de voyage : résumé du parcours (près du vaisseau) ----------
// Sélectionne un trajet/une boucle/une chaîne -> met à jour le parcours (étend si ça s'enchaîne).
// `apresAjout` (optionnel) tourne une fois le parcours à jour mais AVANT le rendu : c'est là que le
// manifeste d'« En route » dépose son chargement ajusté, pour que la jambe s'affiche du premier
// coup avec les bons SCU et son badge ✎.
function pickJourney(legs, apresAjout) {
  if (!legs || !legs.length) return;
  JOURNEY = addToJourney(JOURNEY, legs);
  if (apresAjout) apresAjout();
  syncViewsToJourney();
  renderJourney();
  refresh(); // reflète la nouvelle destination/origine dans la vue courante
}

// « Je suis ici » : pose la position courante et recale les vues. Deux chemins y mènent — le fil
// d'étapes textuel (⦿) et les escales de la carte — et c'est délibéré : la carte n'introduit pas
// une commande, elle en offre une seconde entrée.
function setJourneyStop(i) {
  if (!JOURNEY || !Number.isFinite(i)) return;
  // AVANCER sous-entend qu'on a fait son affaire à l'escale qu'on quitte : ce qu'elle reprend part.
  // Reculer, non — on ne revend pas en revenant sur ses pas.
  if (i > JOURNEY.current) venteImplicite(stationCourante());
  JOURNEY = setJourneyPosition(JOURNEY, i);
  syncViewsToJourney();
  renderJourney();
  refresh();
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
  // Sans cette purge, les manifestes édités survivaient à l'effacement du voyage et ressortaient
  // sur un parcours ULTÉRIEUR passant par les mêmes terminaux, badge ✎ compris.
  JOURNEY_EDITS = {}; saveJourneyEdits();
  JOURNEY_PINS = {}; saveJourneyPins();
  journeyExpandedLeg = -1;
  renderJourney();
  saveState();
}
// Ensemble des commodités transportées au moins une fois sur le parcours (union des manifestes).
function journeyCarriedCommodities() {
  const set = new Set();
  if (!JOURNEY || !MARKET) return set;
  const f = readFilters();
  JOURNEY.legs.forEach((leg, i) => legEffectiveLines(leg, i, f).forEach((l) => set.add(l.name)));
  return set;
}

// Manifeste optimal d'une jambe (from -> to) : remplissage multi-commodité, terminal d'arrivée forcé.
function legManifest(leg, f) {
  if (!MARKET || !stationMap.size) return null;
  const fromIdx = stationMap.get(stationLabel(leg.from, leg.fromSystem));
  const toIdx = stationMap.get(stationLabel(leg.to, leg.toSystem));
  if (fromIdx == null || toIdx == null) return null;
  return bestManifest(MARKET, fromIdx, "", f, effVals, toIdx, feeResolver(f)); // { lines, profit, … } ou null
}

// Contexte de frais d'une jambe. Le récap du voyage est affiché à CÔTÉ des tableaux : le laisser en
// brut pendant que les six vues passent en net mettrait deux chiffres contradictoires côte à côte.
const legFeeCtx = (leg, f) => feeCtx(f, leg.from, leg.to);

// ---------- Édition inline des manifestes de jambe (persistée en localStorage, HORS lien) ----------
// Le PARCOURS (arrêts) va dans l'URL ; les manifestes édités restent locaux.
// On ne persiste que l'INTENTION de l'utilisateur — [{ name, units }] par jambe — jamais un
// instantané de marché : figé, il continuerait d'afficher le prix du jour de l'édition longtemps
// après qu'UEX l'ait republié, et la pastille de fraîcheur vieillirait sans refléter le vrai relevé.
// Prix, stock, demande et dates sont donc RELUS à chaque rendu (cf. hydrateManifestLine).
// Clé versionnée : l'ancien format stockait des lignes complètes sous une clé « from|to » qui
// confondait deux jambes identiques d'un même parcours. Les anciennes éditions sont abandonnées.
const JOURNEY_EDITS_KEY = "best-hauling-journey-edits-v2";
// Jambes dont les quantités ont été FIGÉES par une correction de volume, et non ajustées à la main.
// Store séparé plutôt qu'un champ dans JOURNEY_EDITS : le format persisté de l'intention reste
// intact (aucune migration), et les deux notions se lisent indépendamment. La valeur n'existe que
// si une entrée d'intention existe au même rang — le gel EST une intention, avec un autre motif.
const JOURNEY_PINS_KEY = "best-hauling-journey-pins";
let JOURNEY_PINS = {};
function loadJourneyPins() {
  try { JOURNEY_PINS = JSON.parse(localStorage.getItem(JOURNEY_PINS_KEY)) || {}; } catch { JOURNEY_PINS = {}; }
}
function saveJourneyPins() { try { localStorage.setItem(JOURNEY_PINS_KEY, JSON.stringify(JOURNEY_PINS)); } catch {} }
let JOURNEY_EDITS = {};
let journeyExpandedLeg = -1; // index de la jambe dépliée en édition (-1 = aucune)
function loadJourneyEdits() {
  try { JOURNEY_EDITS = JSON.parse(localStorage.getItem(JOURNEY_EDITS_KEY)) || {}; } catch { JOURNEY_EDITS = {}; }
  try { localStorage.removeItem("best-hauling-journey-edits"); } catch {} // format v1 abandonné
}
function saveJourneyEdits() { try { localStorage.setItem(JOURNEY_EDITS_KEY, JSON.stringify(JOURNEY_EDITS)); } catch {} }
// Le RANG de la jambe fait partie de la clé : sans lui, un parcours A→B→A→B partageait un seul
// manifeste entre ses jambes 1 et 3 (éditer l'une réécrivait l'autre, la supprimer supprimait l'autre).
const legKey = (leg, i) => `${i}|${leg.from}|${leg.to}`;

// Indices des terminaux d'une jambe, ou null si le marché ne les connaît pas (encore).
function legTerminals(leg) {
  const fromIdx = stationMap.get(stationLabel(leg.from, leg.fromSystem));
  const toIdx = stationMap.get(stationLabel(leg.to, leg.toSystem));
  return fromIdx == null || toIdx == null ? null : { fromIdx, toIdx };
}

// Manifeste EFFECTIF d'une jambe : intention éditée ré-hydratée si elle existe, sinon l'optimal.
function legEffectiveLines(leg, i, f) {
  const k = legKey(leg, i);
  const intent = JOURNEY_EDITS[k];
  if (!intent) { const man = legManifest(leg, f); return man ? man.lines : []; }
  const t = legTerminals(leg);
  if (!MARKET || !t) return [];
  const lines = [], gardees = [];
  for (const e of intent) {
    const c = findCommodity(e.name);
    if (!c) continue; // commodité disparue d'UEX : on l'oublie plutôt que d'afficher un fantôme
    gardees.push(e);
    lines.push(hydrateManifestLine(MARKET, t.fromIdx, t.toIdx, c, e.units, effVals));
  }
  // Purge sur place : sans ça l'index des lignes affichées et celui du store divergeraient, et
  // éditer une quantité écrirait dans la mauvaise entrée.
  if (gardees.length !== intent.length) { JOURNEY_EDITS[k] = gardees; saveJourneyEdits(); }
  return lines;
}

// Bascule la jambe en mode « édité » la 1re fois : on y copie l'intention issue de l'optimal.
// Toucher au chargement fait de la jambe une édition PERSONNELLE : si elle n'était que figée par
// une correction de volume, elle cesse de l'être (🔒 -> ✎). Le geste de l'utilisateur prime sur
// la raison technique qui avait gelé les quantités.
function legIntent(leg, i, f) {
  const k = legKey(leg, i);
  if (!JOURNEY_EDITS[k]) JOURNEY_EDITS[k] = manifestIntent(legManifest(leg, f)?.lines || []);
  if (JOURNEY_PINS[k]) { delete JOURNEY_PINS[k]; saveJourneyPins(); }
  return JOURNEY_EDITS[k];
}

// Fige les jambes qu'une correction de volume rebattrait, AVANT qu'elle soit appliquée : on capture
// donc les quantités telles qu'elles sont encore. La sélection est pure (legsToPin) ; ici on ne
// fournit que ce que logic.mjs ne peut pas connaître — les chargements effectifs du moment.
function pinLegsForVolume(commodity, terminal, side) {
  if (!JOURNEY || !JOURNEY.legs.length || !MARKET) return;
  const f = readFilters();
  const lignes = JOURNEY.legs.map((leg, i) => legEffectiveLines(leg, i, f));
  let change = false;
  for (const i of legsToPin(JOURNEY.legs, lignes, commodity, terminal, side)) {
    const k = legKey(JOURNEY.legs[i], i);
    if (JOURNEY_EDITS[k]) continue; // déjà ajustée ou figée : ses quantités ne bougeaient déjà plus
    JOURNEY_EDITS[k] = manifestIntent(lignes[i]);
    JOURNEY_PINS[k] = true;
    change = true;
  }
  if (change) { saveJourneyEdits(); saveJourneyPins(); }
}

// Engage le manifeste d'« En route » comme nouvelle jambe du voyage (bouton de la carte Manifeste).
// La garde d'état est REJOUÉE ici : le rendu peut dater d'avant un changement de parcours.
function manifestToJourney() {
  const m = currentManifest;
  if (!m || !m.lines.length || !MARKET) return;
  if (manifestJourneyState(JOURNEY, m.origin, m.dest).etat !== "ajouter") return;
  const intent = manifestIntent(m.lines);
  pickJourney([legFromManifest(m)], () => {
    const i = JOURNEY.legs.length - 1;
    const k = legKey(JOURNEY.legs[i], i);
    // Ce que legManifest recalculera pour cette jambe. Si le chargement affiché EST celui-là, on ne
    // persiste rien : la jambe reste branchée sur le marché et sur les filtres, et ne porte pas le
    // badge ✎ à tort. On impose l'état de la clé dans les DEUX sens, pour qu'une édition laissée
    // par un voyage abandonné au même rang et au même couple de stations ne vienne pas contredire
    // le chargement qu'on envoie.
    const opt = bestManifest(MARKET, m.originIdx, "", m.f, effVals, m.destIdx, feeResolver(m.f));
    if (sameIntent(intent, manifestIntent(opt ? opt.lines : []))) delete JOURNEY_EDITS[k];
    else JOURNEY_EDITS[k] = intent;
    saveJourneyEdits();
  });
}

// Contexte de manifeste d'une jambe, à la forme attendue par suggestionsFor/manifestRemaining
// (mêmes suggestions de remplissage qu'« En route »). null si le terminal ou la soute manque.
function legSuggestCtx(leg, lines, f) {
  if (!MARKET || !stationMap.size) return null;
  if (!f.useCargo || !(f.cargo > 0)) return null; // sans soute bornée, « SCU libres » n'a pas de sens
  const originIdx = stationMap.get(stationLabel(leg.from, leg.fromSystem));
  const destIdx = stationMap.get(stationLabel(leg.to, leg.toSystem));
  if (originIdx == null || destIdx == null) return null;
  const ctx = legFeeCtx(leg, f);
  return {
    lines, originIdx, destIdx,
    origin: { name: leg.from, system: leg.fromSystem },
    dest: { name: leg.to, system: leg.toSystem },
    cargo: f.cargo, f, fee: ctx && ctx.pair, // même filtrage des suggestions qu'« En route »
  };
}

// Actions d'édition d'une jambe (i = index de jambe).
function toggleLegEditor(i) { journeyExpandedLeg = journeyExpandedLeg === i ? -1 : i; renderJourney(); }
function editLegQty(i, li, val) {
  // Le voyage peut avoir été effacé entre le focus et le blur (cliquer ✕ blure d'abord le champ) :
  // sans cette garde, l'édition en vol était réécrite APRÈS la purge et ressuscitait toute seule.
  if (!JOURNEY || !JOURNEY.legs[i]) return;
  const intent = legIntent(JOURNEY.legs[i], i, readFilters());
  if (intent[li]) { const u = Math.floor(Number(val)); intent[li].units = Number.isFinite(u) && u > 0 ? u : 0; }
  saveJourneyEdits();
  // Ce handler part sur `change`, donc au BLUR — or le blur précède le mouseup d'un clic en cours.
  // Re-rendre tout de suite détruirait le nœud visé et avalerait ce clic (impossible d'effacer le
  // voyage ou de replier une jambe du premier coup). On laisse le tour d'événement se terminer.
  setTimeout(renderJourney, 0);
}
// Saisie en direct : met à jour l'intention + repeint profit/caisses/suggestions SANS re-render
// global (un renderJourney() à chaque frappe ferait perdre le focus de l'input).
function liveLegQty(i, li, inp) {
  if (!JOURNEY || !JOURNEY.legs[i]) return; // idem : le parcours a pu disparaître sous la saisie
  const leg = JOURNEY.legs[i];
  const f = readFilters();
  const intent = legIntent(leg, i, f);
  if (!intent[li]) return;
  let u = Math.floor(Number(inp.value));
  if (!Number.isFinite(u) || u < 0) u = 0;
  intent[li].units = u;
  const lines = legEffectiveLines(leg, i, f); // relues au marché COURANT, jamais figées
  const l = lines[li];
  if (!l) return;
  inp.classList.toggle("over-stock", isFinite(l.cap) && u > l.cap);
  const ctx = legFeeCtx(leg, f);
  const pair = ctx && ctx.pair;
  const row = inp.closest(".jman-line");
  const prof = row && row.querySelector(".jman-profit");
  if (prof) prof.textContent = lineProfitText(u, l, pair);
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
  const ctx = legSuggestCtx(leg, legEffectiveLines(leg, i, f), f);
  if (!ctx) return;
  const it = suggestionsFor(ctx).find((x) => x.name === name);
  if (!it) return;
  const u = addableUnits(it, manifestRemaining(ctx));
  if (u <= 0) return;
  legIntent(leg, i, f).push({ name: it.name, units: u });
  saveJourneyEdits(); renderJourney();
}
function delLegLine(i, name) {
  const leg = JOURNEY.legs[i];
  JOURNEY_EDITS[legKey(leg, i)] = legIntent(leg, i, readFilters()).filter((e) => e.name !== name);
  saveJourneyEdits(); renderJourney();
}
// « ↺ optimal » lève les deux formes d'intention, l'ajustement manuel comme le gel.
function resetLeg(i) {
  const k = legKey(JOURNEY.legs[i], i);
  delete JOURNEY_EDITS[k]; delete JOURNEY_PINS[k];
  saveJourneyEdits(); saveJourneyPins(); renderJourney();
}
// Ajout LIBRE d'une commodité à une jambe (même non vendable à l'arrivée -> ligne « carry-only »).
// Même règle qu'« En route » : freeManifestLine (logic.mjs) en est la source unique.
function addLegLine(i, name) {
  const leg = JOURNEY.legs[i];
  const c = findCommodity(name);
  const t = legTerminals(leg);
  if (!c || !t || !MARKET) return;
  const f = readFilters();
  // Le doublon se teste AVANT de matérialiser l'intention : sinon un ajout refusé basculait quand
  // même la jambe en « éditée » (badge ✎, bouton « ↺ optimal »), et elle cessait silencieusement
  // de suivre les prix UEX et les filtres alors que rien n'avait été ajouté.
  if (legEffectiveLines(leg, i, f).some((l) => l.name === c.name)) return;
  const ctx = legSuggestCtx(leg, legEffectiveLines(leg, i, f), f); // null si soute non bornée -> 1 SCU
  const ligne = freeManifestLine(MARKET, t.fromIdx, t.toIdx, c, ctx ? manifestRemaining(ctx).cargoLeft : NaN, effVals);
  legIntent(leg, i, f).push({ name: c.name, units: ligne.units });
  saveJourneyEdits(); renderJourney();
}

// Index du terminal de FIN de parcours (point d'extension), ou null.
function journeyEndIndex() {
  const end = journeyEnd(JOURNEY);
  return end && stationMap.size ? stationMap.get(stationLabel(end.name, end.system)) : null;
}
// Meilleure jambe (commodité de marge max) entre deux terminaux, ou null si aucun fret rentable.
// `readFilters()` fait choisir la vente au profit RÉALISABLE et non au prix affiché : sans lui,
// la jambe proposée peut viser un terminal déjà saturé, qui n'écoulera qu'une poignée de SCU.
function bestLegTo(fromIdx, toIdx) {
  if (fromIdx == null || toIdx == null) return null;
  return bestLegBetween(MARKET, fromIdx, toIdx, readFilters());
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
  return fromIdx == null ? [] : stopSuggestions(MARKET, fromIdx, readFilters());
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
  if (!stationMap.size) { withMarket(() => beginJourney(v)); return; } // marché requis pour résoudre
  const startIdx = resolveStationLabel(v);
  if (startIdx == null) return; // terminal inconnu
  const t = MARKET.terminals[startIdx];
  JOURNEY = startJourneyAt({ name: t.name, system: t.system });
  syncViewsToJourney();
  renderJourney();
  refresh();
}

// Retire un arrêt (index de station) et RECONNECTE les voisins (recalcule la jambe A->C).
// Réindexe les manifestes édités après une modification du parcours : la clé porte le RANG de la
// jambe, donc retirer un arrêt décalerait sinon l'édition d'une jambe sur sa voisine.
function reindexLegEdits(removedFrom, removedCount, insertedCount) {
  const decalage = removedCount - insertedCount;
  // Les deux stores sont indexés par le MÊME rang de jambe : les décaler séparément les ferait
  // diverger, et un 🔒 se retrouverait sur une jambe dont l'intention a disparu.
  const decale = (store) => {
    const suivant = {};
    for (const [k, v] of Object.entries(store)) {
      const sep = k.indexOf("|");
      const i = Number(k.slice(0, sep));
      if (i < removedFrom) suivant[k] = v;                       // avant la coupe : inchangé
      else if (i < removedFrom + removedCount) continue;         // jambe disparue : son édition part
      else suivant[`${i - decalage}${k.slice(sep)}`] = v;        // après : recule d'autant
    }
    return suivant;
  };
  JOURNEY_EDITS = decale(JOURNEY_EDITS);
  JOURNEY_PINS = decale(JOURNEY_PINS);
  if (journeyExpandedLeg >= removedFrom) journeyExpandedLeg = -1; // le panneau déplié n'existe plus
  saveJourneyEdits(); saveJourneyPins();
}

function removeJourneyStop(stopIndex) {
  if (!JOURNEY) return;
  const legs = JOURNEY.legs;
  let bridge = null;
  if (stopIndex > 0 && stopIndex < legs.length) {
    // Arrêt du milieu : on reconnecte stations[i-1] -> stations[i+1].
    const prev = legs[stopIndex - 1], next = legs[stopIndex];
    const fromIdx = stationMap.get(stationLabel(prev.from, prev.fromSystem));
    const toIdx = stationMap.get(stationLabel(next.to, next.toSystem));
    bridge = bestLegTo(fromIdx, toIdx) || // aucun fret rentable A->C : jambe « à vide », contiguïté préservée
      { from: prev.from, fromSystem: prev.fromSystem, to: next.to, toSystem: next.toSystem, commodity: "", buyPrice: 0, sellPrice: 0, margin: 0 };
  }
  const r = removeStopPure(JOURNEY, stopIndex, bridge);
  if (!r) { clearJourney(); return; }
  reindexLegEdits(r.removedFrom, r.removedCount, r.insertedCount);
  // `start` n'est présent que sur le parcours réduit à un seul arrêt : le reporter tel quel, sinon
  // la station survivante n'a plus rien pour se décrire (journeyStations la lit là) et le voyage
  // s'affiche vide alors qu'il reste un point de départ.
  JOURNEY = r.start ? { legs: [], current: 0, start: r.start } : { legs: r.legs, current: r.current };
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
    renderJourneyMap();
    renderSoute();
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
  if (!MARKET) { withMarket(renderJourney); }
  else if (!enrouteReady) setupEnRoute();

  const stations = journeyStations(JOURNEY);
  const path = stations
    .map((s, i) => `<span class="jstep-wrap"><button class="jstep${i === JOURNEY.current ? " here" : ""}" data-i="${i}" title="Je suis ici"><span class="sys ${esc(s.system.toLowerCase())}">${esc(s.name)}</span></button><button class="jstep-del" data-i="${i}" title="Retirer cet arrêt" aria-label="Retirer">✕</button></span>`)
    .join('<span class="jsep">→</span>');
  const n = JOURNEY.legs.length;
  const f = readFilters();
  let totalProfit = 0, totalScu = 0, totalFees = 0; // récap : profit réel, SCU et frais du voyage
  // Manifeste (cargaison) de chaque jambe — optimal ou édité ; jambe dépliable pour l'éditer.
  const legsHtml = JOURNEY.legs.map((leg, i) => {
    const lines = MARKET ? legEffectiveLines(leg, i, f) : null;
    const pair = MARKET ? (legFeeCtx(leg, f) || {}).pair : null;
    const edited = MARKET && !!JOURNEY_EDITS[legKey(leg, i)];
    const pinned = edited && !!JOURNEY_PINS[legKey(leg, i)]; // figée par une correction, pas par toi
    const charge = MARKET && jambeChargee(leg, i); // ce manifeste est-il déjà en soute ?
    const expanded = i === journeyExpandedLeg;
    let cargo, total;
    if (!MARKET) { cargo = '<span class="muted">calcul…</span>'; total = "—"; }
    else if (!lines.length) { cargo = '<span class="muted">aucun fret rentable</span>'; total = "0"; }
    else {
      cargo = lines.map((l) => `<span class="jcargo-item">${freshDot(lineFreshUpdated(l))}${commodityIcon(l.kind)}<span>${esc(l.name)}${illegalTag(l.illegal)}</span> <b>${fmt(l.units)} SCU</b></span>`).join("");
      const t = manifestTotals(lines, pair);
      total = fmtFee(t.profit, t.fees);
      totalProfit += t.profit;
      totalFees += t.fees;
      totalScu += lines.reduce((s, l) => s + l.units, 0);
    }
    let editor = "";
    if (expanded && MARKET) {
      const rows = lines.map((l, li) =>
        `<div class="jman-line">${commodityIcon(l.kind)}` +
        `<span class="mqtywrap"><input type="number" class="jman-qty" min="0" value="${l.units}" data-leg="${i}" data-i="${li}" aria-label="SCU ${esc(l.name)}"><span class="munit">SCU</span></span>` +
        `<span class="jman-name">${freshDot(lineFreshUpdated(l))}${esc(l.name)}${illegalTag(l.illegal)}${l.acquired ? ' <span class="carry-tag" title="Introuvable à l\'achat ici — fret déjà en soute">acquis ailleurs</span>' : ""}${l.sellPrice == null ? ' <span class="carry-tag">vend ailleurs</span>' : ""}</span>` +
        `<span class="jman-profit profit">${lineProfitText(l.units, l, pair)}</span>` +
        `<button class="jman-del" data-leg="${i}" data-name="${esc(l.name)}" title="Retirer">✕</button></div>`
      ).join("") || '<div class="muted jman-empty">Aucune commodité.</div>';
      const sctx = legSuggestCtx(leg, lines, f);
      editor = `<div class="jman">${rows}
        <div class="jman-add"><input class="jman-add-input" list="commodityList" data-leg="${i}" placeholder="+ commodité (même non vendable)…" autocomplete="off"><button class="jman-add-btn" data-leg="${i}">+</button>${edited ? `<button class="jman-reset" data-leg="${i}" title="Revenir au manifeste optimal">↺ optimal</button>` : ""}</div>
        <div class="jman-suggest manifest-suggest" data-leg="${i}">${sctx ? suggestionsHTML(sctx, ` data-leg="${i}"`) : ""}</div>
      </div>`;
    }
    return `<div class="jleg${i === JOURNEY.current ? " current" : ""}${expanded ? " expanded" : ""}">
        <div class="jleg-head" data-leg="${i}" role="button" tabindex="0" title="Éditer le manifeste de cette jambe"><span class="jleg-n">${i + 1}</span><span class="jleg-route">${esc(leg.from)} → ${esc(leg.to)}</span>${edited ? (pinned
          ? '<span class="jleg-pinned" title="Quantités figées : le stock ou la demande de ce chargement a été corrigé depuis. Le trajet reste tel que tu l\'as décidé — les prix, eux, continuent de suivre le marché. « ↺ optimal » recalcule tout.">🔒</span>'
          : '<span class="jleg-edited" title="Manifeste personnalisé">✎</span>') : ""}${MARKET && lines && lines.length ? `<button class="jleg-load${charge ? " charge" : ""}" data-leg="${i}" title="${charge ? "Annuler : ce chargement n'est plus à bord" : "J'ai payé et chargé ce manifeste — il entre en soute à ce prix"}">${charge ? "⬢ à bord" : "✓ chargé"}</button>` : ""}<span class="jleg-profit profit">+${total}</span><span class="jleg-caret">${expanded ? "▾" : "▸"}</span></div>
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

  renderJourneyRecap({ n, totalProfit, totalScu, totalFees, systems: new Set(stations.map((s) => s.system)).size });
  renderJourneyMap();
  renderSoute();
}

// Récap du voyage (colonne de gauche, sous le vaisseau) : remplit l'espace avec des KPIs utiles.
function renderJourneyRecap({ n, totalProfit, totalScu, totalFees, systems }) {
  const recap = $("journeyRecap");
  if (!recap) return;
  recap.hidden = false;
  const materials = MARKET ? journeyCarriedCommodities().size : 0;
  const kpi = (v, lbl) => `<div class="recap-kpi"><b>${v}</b><span>${lbl}</span></div>`;
  recap.innerHTML =
    `<div class="recap-head">◈ Résumé du voyage</div>
     <div class="recap-profit"${totalFees > 0 ? ` title="Frais d'autoload ≈ ${fmt(totalFees)} aUEC déjà déduits — estimation (±3 %)"` : ""}>${MARKET ? (totalFees > 0 ? "≈ +" : "+") + fmt(totalProfit) : "…"} <span>aUEC</span></div>
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
// Regroupe les appels rapprochés en un seul, à la fin de la salve.
const debounce = (fn, ms = 150) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

function refresh() {
  if (view === "loops") renderLoops();
  else if (view === "enroute") renderEnRoute();
  else if (view === "chain") renderChain();
  else if (view === "corrections") renderCorrections();
  else if (view === "commodities") renderCommodities();
  else render();
  // La carte Voyage est affichée À CÔTÉ des tableaux, dans toutes les vues : la laisser hors du
  // cycle de rendu la figeait sur l'état d'avant. Corriger un prix ne mettait donc pas à jour les
  // bénéfices du voyage — alors qu'une jambe non ajustée est justement, par contrat, branchée sur
  // le marché et sur les filtres (cf. README). Le coût est celui d'un manifeste par jambe, sur un
  // parcours qui en compte une poignée ; les champs à saisie libre passent déjà par un debounce.
  if (JOURNEY) renderJourney();
  saveState();
}
const refreshDebounced = debounce(refresh);

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

// Trier est une action à part entière : une souris ne doit pas être la seule façon de la déclencher.
// Même patron clavier que les valeurs corrigeables (`.editv`) : le clic et Entrée/Espace passent par
// le MÊME corps, et `tabindex` est posé ici si index.html ne l'a pas fait. Pas de `role="button"`
// ici, contrairement à `.editv` : il écraserait le rôle `columnheader` du <th>, seul rôle sur lequel
// `aria-sort` veut dire quelque chose — on perdrait l'annonce de la colonne triée en la corrigeant.
function sortableHeader(th, apply) {
  if (!th.hasAttribute("tabindex")) th.tabIndex = 0;
  th.addEventListener("click", apply);
  th.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apply(); } // Espace ne doit pas défiler la page
  });
}

function setupSort() {
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    sortableHeader(th, () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        sortDir = key === "commodity" ? 1 : -1;
      }
      applySortIndicators(); // classes ET aria-sort, pour les deux tables
      render();
      saveState();
    });
  });
}

function setupLoopSort() {
  document.querySelectorAll("th[data-sort-loop]").forEach((th) => {
    sortableHeader(th, () => {
      const key = th.dataset.sortLoop;
      if (loopSortKey === key) loopSortDir *= -1;
      else { loopSortKey = key; loopSortDir = -1; }
      applySortIndicators();
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
// `alk` = coefficient d'autoload global : partageable, comme tous les réglages. Les relevés PAR
// STATION, eux, restent locaux — c'est la même frontière que pour les corrections de prix.
const STATE_FIELDS = ["cargo", "budget", "search", "system", "freshness", "ship", "origin", "destSystem", "destTerminal", "chainOrigin", "hops", "station", "alk", "multiMode"];
const STATE_CHECKS = ["useCargo", "useBudget", "sameSystem", "noOutpost", "legalOnly", "capStock", "multiCommodity", "autoload"];
// Champs qui gardent leur défaut HTML quand la clé est absente de l'état. #system, #freshness et
// #destSystem ont chacun une option VIDE (« Tous », « Toutes », « N'importe où ») : leur poser ""
// resélectionne bien ce défaut. #hops, lui, n'en a pas (2 / 3 / 4) — lui poser "" laisserait le menu
// visuellement VIDE alors que le calcul retomberait silencieusement sur 3 sauts.
const STATE_FIELDS_KEEP_DEFAULT = ["hops"];
// safeKey / encodeState / decodeState viennent de logic.mjs.

let restoring = false; // évite de resauver pendant qu'on applique un état

function collectState() {
  // `cb` : board des commodités. Vide en mode Marché (défaut) -> encodeState l'omet, l'URL reste courte.
  const s = { v: view, sk: sortKey, sd: sortDir, lk: loopSortKey, ld: loopSortDir, cb: commBoard === "loot" ? "loot" : "" };
  STATE_FIELDS.forEach((id) => (s[id] = $(id).value));
  STATE_CHECKS.forEach((id) => (s[id] = $(id).checked ? 1 : 0));
  if (JOURNEY) s.j = encodeJourney(JOURNEY); // compagnon de voyage (partageable)
  return s;
}

// Écrit l'état dans localStorage et renvoie sa forme encodée (null pendant une restauration : rien
// à resauver). TOUJOURS synchrone, y compris depuis la variante différée ci-dessous : une session ne
// doit pas se perdre parce que l'onglet a été rechargé ou fermé dans la demi-seconde qui suit.
function persistState() {
  if (restoring) return null;
  const str = encodeState(collectState());
  try { localStorage.setItem(STATE_KEY, str); } catch {}
  return str;
}

// Recopie l'état dans le hash de l'URL. WebKit plafonne replaceState à 100 appels / 10 s et lève
// SecurityError au-delà. L'URL n'est pas critique (localStorage porte déjà l'état, et l'écriture
// suivante réécrit TOUT, elle n'est pas incrémentale) — mais l'exception remontait jusqu'à
// copyShareLink, qui appelle saveState en PREMIÈRE instruction : le bouton « Partager » ne copiait
// alors plus rien, sans le moindre retour visuel.
function writeHash(str) {
  try {
    history.replaceState(null, "", str ? "#" + str : location.pathname + location.search);
  } catch {}
}

// URL à partager, reconstruite depuis l'état ENCODÉ — jamais relue dans `location.href`. Une
// écriture de hash plafonnée est perdue pour de bon : la barre d'adresse reste alors figée au
// milieu de la rafale, et copier `location.href` partagerait des filtres périmés tout en
// annonçant « ✓ Lien copié », donc sans que rien ne le signale.
function shareURL(str) {
  const rel = str ? location.pathname + location.search + "#" + str : location.pathname + location.search;
  return new URL(rel, location.href).href;
}

// Sauvegarde complète ; renvoie l'état encodé (null pendant une restauration). Le hash est écrit
// IMMÉDIATEMENT, jamais différé : `loadState()` le fait PRIMER sur localStorage, donc un hash en
// retard — fût-ce de quelques centaines de ms — ressusciterait au rechargement l'état d'AVANT la
// dernière action (vue, filtres, station…). Le plafond WebKit se traite EN AMONT, à la source :
// tous les champs à saisie libre sont débouncés (cf. init), une rafale de frappe ne vaut donc plus
// qu'un seul appel. Le `try/catch` de writeHash n'est que le filet de sécurité.
function saveState() {
  const str = persistState();
  if (str == null) return null;
  writeHash(str);
  return str;
}

function loadState() {
  let str = location.hash.replace(/^#/, "");
  if (!str) { try { str = localStorage.getItem(STATE_KEY) || ""; } catch {} }
  return decodeState(str);
}

// Positionne l'indicateur ▾/▴ sur la bonne colonne des deux tables.
// La flèche est un `::after` CSS accroché aux classes : elle n'existe pas pour un lecteur d'écran.
// `aria-sort` DOUBLE donc les classes (il ne les remplace pas, le CSS s'en sert) sur les seules
// colonnes triables — le poser sur un <th> décoratif annoncerait une colonne triable qui ne l'est pas.
function applySortIndicators() {
  document.querySelectorAll("#routes th, #loops th").forEach((h) => {
    h.classList.remove("sorted-asc", "sorted-desc");
    if (h.dataset.sort || h.dataset.sortLoop) h.setAttribute("aria-sort", "none");
  });
  if (safeKey(sortKey)) {
    const th = document.querySelector(`#routes th[data-sort="${sortKey}"]`);
    if (th) {
      th.classList.add(sortDir === -1 ? "sorted-desc" : "sorted-asc");
      th.setAttribute("aria-sort", sortDir === -1 ? "descending" : "ascending");
    }
  }
  if (safeKey(loopSortKey)) {
    const th = document.querySelector(`#loops th[data-sort-loop="${loopSortKey}"]`);
    if (th) {
      th.classList.add(loopSortDir === -1 ? "sorted-desc" : "sorted-asc");
      th.setAttribute("aria-sort", loopSortDir === -1 ? "descending" : "ascending");
    }
  }
}

function applyState(s) {
  if (!s) return;
  restoring = true;
  // Lecture SYMÉTRIQUE de l'écriture : encodeState omet les valeurs vides (URL courte), donc dans un
  // état venant de l'app une clé absente veut dire « champ vidé », pas « champ jamais renseigné ».
  // Sans ça, un budget effacé à la main revenait à 1 000 000 au rechargement — et le destinataire du
  // lien voyait un autre classement que son émetteur.
  // Encore faut-il que l'état VIENNE de l'app : n'importe quelle ancre (#top) se décode elle aussi en
  // objet, et vider tous les champs sur cette foi accueillerait l'arrivant sans soute ni budget.
  // `v` (la vue) est écrite à chaque sauvegarde par collectState et n'est jamais vide : elle signe l'état.
  const mine = s.v != null;
  STATE_FIELDS.forEach((id) => {
    if (s[id] != null) $(id).value = s[id];
    else if (mine && !STATE_FIELDS_KEEP_DEFAULT.includes(id)) $(id).value = "";
  });
  STATE_CHECKS.forEach((id) => { if (s[id] != null) $(id).checked = s[id] === "1"; });
  if (safeKey(s.sk)) { sortKey = s.sk; sortDir = Number(s.sd) === 1 ? 1 : -1; }
  if (safeKey(s.lk)) { loopSortKey = s.lk; loopSortDir = Number(s.ld) === 1 ? 1 : -1; }
  if (["routes", "loops", "enroute", "chain", "corrections", "commodities"].includes(s.v)) view = s.v;
  if (s.cb === "loot") commBoard = "loot";
  if (s.j) JOURNEY = decodeJourney(s.j); // compagnon de voyage restauré (les champs sont déjà repris ci-dessus)
  applySortIndicators();
  syncToggles();
  syncCommBoardUI(); // bouton actif + libellé « Revente » restaurés avant le premier rendu
  restoring = false;
}

async function copyShareLink() {
  const str = saveState();
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(shareURL(str));
    const prev = btn.textContent;
    const prevLabel = btn.getAttribute("aria-label");
    btn.textContent = "✓ Lien copié";
    // L'aria-label PRIME sur le contenu : sans ce miroir, le retour de copie n'existerait que pour
    // les voyants, le nom accessible restant figé sur « Partager — … ».
    btn.setAttribute("aria-label", "✓ Lien copié");
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = prev;
      btn.setAttribute("aria-label", prevLabel);
      btn.classList.remove("copied");
    }, 1500);
  } catch {
    // Presse-papiers indisponible (contexte non sécurisé) : on laisse l'URL dans la barre.
  }
}

// ---------- Édition inline d'une valeur corrigeable ----------
// Remplace le span par un champ ; à la validation, enregistre la correction et rafraîchit.
function startEdit(span) {
  if (span.querySelector("input")) return;
  const { c, t, s, f: field, v, u } = span.dataset;
  // Contenu d'origine (chiffre formaté + éventuel ✎), conservé pour pouvoir annuler l'édition
  // sans re-render global. `replaceChildren` détache ces nœuds mais ne les détruit pas.
  const original = [...span.childNodes];
  const inp = document.createElement("input");
  inp.type = "number"; inp.min = "0"; inp.value = v; inp.className = "editv-input";
  span.replaceChildren(inp);
  inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    // CONSULTER un chiffre ne doit rien écrire. Sans cette comparaison, cliquer une valeur puis
    // cliquer ailleurs créait une correction locale IDENTIQUE au relevé UEX : compteur « ✎
    // Corrections (n) », marqueur « corrigé localement » sur la cellule, et plus tard un toast
    // « correction périmée par une mise à jour UEX » à propos d'une correction fantôme.
    if (save && inp.value !== v) {
      // Un VOLUME rebat les quantités de tout chargement qui touche ce point : on fige d'abord les
      // jambes déjà planifiées (avant d'écrire, pour capturer les SCU encore en vigueur). Un PRIX
      // ne change aucune quantité — il ne fige rien, il met juste les bénéfices à jour.
      if (field === "vol") pinLegsForVolume(c, t, s);
      setOverride(c, t, s, field, inp.value === "" ? null : inp.value, Number(u));
      updateOvBadge();
      refresh(); // re-render la vue courante ET le voyage avec la valeur corrigée
      return;
    }
    // Rien n'a changé : on remet l'affichage tel quel. Un refresh() global détruirait le nœud
    // entre le mousedown et le mouseup, ce qui avalait le clic suivant sur une autre cellule.
    span.replaceChildren(...original);
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

// Enregistre un relevé de tarif d'autoload pour la station affichée. On mémorise le montant et la
// quantité observés en plus de `k` : c'est la MESURE qui fait foi, `k` n'en est que la lecture — si
// la grille change à un patch, un relevé conservé reste réinterprétable.
function saveStationReading() {
  if (stationSel == null) return;
  const t = MARKET.terminals[stationSel];
  const amount = Number($("alAmount").value);
  const scu = Math.floor(Number($("alScu").value));
  const k = kFromReading(amount, scu, t.maxBox);
  if (k == null) { showToast("⚠ Relevé inutilisable — indique le montant payé et la quantité chargée"); return; }
  AUTOLOAD_K[alKey(t.name)] = { k, amount, scu };
  saveAutoloadK();
  refresh();
}
function forgetStationReading(key) { delete AUTOLOAD_K[key]; saveAutoloadK(); refresh(); }
function resetAllReadings() {
  if (!Object.keys(AUTOLOAD_K).length) return;
  if (!confirm("Oublier tous tes relevés de tarif d'autoload ?")) return;
  AUTOLOAD_K = {};
  saveAutoloadK();
  refresh();
}

// ---------- Vue « Corrections » : liste + édition par station ----------
function resolveStation() {
  const v = $("station").value.trim();
  stationSel = stationMap.has(v) ? stationMap.get(v) : null;
}

// Relevé du tarif d'autoload d'une station. L'utilisateur ne saisit PAS `k` : personne ne lit un
// coefficient en jeu, on lit une facture. Il donne un montant observé pour une quantité, et `k` s'en
// déduit. Les champs ne portent PAS la classe `.editv` : le handler global de l'édition inline
// l'attrape partout dans le document et écrirait dans les corrections de prix.
function stationFeeHTML(S) {
  const t = MARKET.terminals[S];
  const head = `<div class="fee-head">◈ Frais d'autoload — ${esc(t.name)}</div>`;
  const wrap = (body) => `<div class="fee-panel">${head}${body}</div>`;
  // Deux non-dits distincts, et aucun ne doit se lire « 0 aUEC » : le champ absent (instantané de
  // market.json antérieur au build qui l'ajoute) et le service réellement indisponible.
  if (t.autoload == null) return wrap('<p class="fee-off">Donnée d\'autoload absente de cet export UEX : aucun frais n\'est facturé à cette station tant qu\'elle manque.</p>');
  if (t.autoload !== true) return wrap('<p class="fee-off">Cette station ne propose pas l\'autoload : aucun frais n\'y est facturé, quel que soit ton réglage.</p>');
  const rec = AUTOLOAD_K[alKey(t.name)];
  const k = kFor(t.name);
  const scu = rec ? rec.scu : 32;
  const note = `<div class="fee-note">Tarif retenu : <b>k = ${k.toLocaleString("fr-FR", { maximumFractionDigits: 3 })}</b> ${rec ? "(ton relevé)" : "(k global)"} — soit ≈ <b>${fmt(autoloadFee(scu, t.maxBox, k))}</b> aUEC pour ${fmt(scu)} SCU${t.maxBox ? `, caisses de ${fmt(t.maxBox)} SCU max` : ""}.</div>`;
  return wrap(
    `<div class="fee-row">
       <span>Montant observé</span>
       <input id="alAmount" type="number" min="0" step="1" value="${rec ? rec.amount : ""}" placeholder="ex : 1159" aria-label="Montant payé en aUEC" />
       <span>aUEC pour</span>
       <input id="alScu" type="number" min="1" step="1" value="${scu}" aria-label="Quantité en SCU" />
       <span>SCU</span>
       <button id="alSave" type="button" class="copy-btn">Enregistrer</button>
       ${rec ? `<button type="button" class="corr-del al-del" data-key="${esc(alKey(t.name))}" title="Oublier ce relevé" aria-label="Oublier ce relevé">✕</button>` : ""}
     </div>${note}`
  );
}

// Tableau éditable des commodités d'une station (prix/stock à l'achat, prix/demande à la vente).
function stationTableHTML(S, q) {
  const t = MARKET.terminals[S];
  // DEUX sections : ce qu'on peut acheter ici, puis ce qu'on peut y vendre. Mesuré sur
  // l'instantané : aucune commodité n'est des deux côtés au même comptoir (0 sur 2 373 couples,
  // 114 stations) — un terminal achète ou vend, jamais les deux. La règle « les deux -> avec les
  // achats » est donc écrite mais inerte ; elle protège d'un changement de données, pas d'un cas
  // observé. La répartition, elle, est très déséquilibrée : GrimHEX offre 3 achats pour 89 ventes,
  // et ces trois-là se perdaient au milieu des quatre-vingt-neuf autres.
  const achats = [], ventes = [];
  MARKET.commodities.forEach((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return;
    const b = c.buys.find((x) => x[0] === S);
    const s = c.sells.find((x) => x[0] === S);
    if (!b && !s) return;
    const cote = (p, side, libelle, unite) => {
      const e = effVals(c.name, t.name, side, p[1], p[2], p[3]);
      return `<div class="scomm-side"><span class="scomm-lbl">${libelle}</span>` +
        `${editv(c.name, t.name, side, "price", e.price, e.oprice, p[3])} aUEC · ${unite} ` +
        `${editv(c.name, t.name, side, "vol", e.vol, e.ovol, p[3])}</div>`;
    };
    // Une seule ligne par côté RÉEL : plus de « achat — » à afficher sous chaque vente.
    const corps = (b ? cote(b, "buy", "achat", "stock") : "") + (s ? cote(s, "sell", "vente", "dem.") : "");
    // La classe porte le côté : c'est elle qui donne au liseré et à l'étiquette leur couleur.
    // Nécessaire depuis qu'une tuile n'affiche plus qu'une ligne — l'en-tête de section sort de
    // l'écran au défilement, et il ne restait alors rien pour dire ce qu'on regarde.
    const tuile = `<div class="scomm ${b ? "achat" : "vente"}">
        <div class="scomm-name">${commodityIcon(c.kind)}<span>${esc(c.name)}${illegalTag(c.illegal)}</span></div>
        ${corps}
      </div>`;
    (b ? achats : ventes).push(tuile);
  });

  const fee = stationFeeHTML(S);
  const total = achats.length + ventes.length;
  if (!total) return `${fee}<p class="empty">Aucune commodité ${q ? "correspondante " : ""}à ${esc(t.name)}.</p>`;
  const section = (cle, titre, aide, tuiles) => tuiles.length
    ? `<div class="station-section"><h4 class="station-section-head ${cle}">◈ ${titre} <span class="station-count">${tuiles.length}</span><span class="station-section-aide">${aide}</span></h4>
       <div class="station-grid">${tuiles.join("")}</div></div>`
    : "";
  return `<div class="station-title">◈ ${esc(t.name)}${sysBadge(t.system)} — clique un chiffre pour le corriger localement <span class="station-count">${total} commodité${total > 1 ? "s" : ""}${q ? " filtrées" : ""}</span></div>
    ${fee}
    ${section("achat", "On y achète", "ce que la station te vend — prix et stock", achats)}
    ${section("vente", "On y vend", "ce qu'elle te reprend — prix et demande", ventes)}`;
}

// Liste des relevés d'autoload, à côté des corrections locales et sur le même modèle : ils sont de
// la même nature (mesures faites en jeu, purement locales), mais ils ne comptent PAS dans le badge
// « ✎ Corrections (n) » et « Tout réinitialiser » ne les touche pas — ils ont leur propre store.
function autoloadListHTML() {
  const keys = Object.keys(AUTOLOAD_K);
  if (!keys.length) return "";
  const items = keys.sort().map((key) => {
    const o = AUTOLOAD_K[key];
    const terminal = key.slice(key.indexOf("|") + 1);
    return `<div class="corr-item autoload"><div><b>${esc(terminal)}</b> <span class="corr-side">autoload</span><div class="loc-sub">k = <b>${o.k.toLocaleString("fr-FR", { maximumFractionDigits: 3 })}</b> · ${fmt(o.amount)} aUEC observés pour ${fmt(o.scu)} SCU</div></div><button class="corr-del al-del" data-key="${esc(key)}" title="Oublier ce relevé">✕</button></div>`;
  }).join("");
  return `<div class="corr-list-head"><span>${keys.length} relevé${keys.length > 1 ? "s" : ""} d'autoload</span><button id="resetAllK" class="reset-ov">Tout oublier</button></div>${items}`;
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
  if (!MARKET) { withMarket(refresh); return; }
  if (!enrouteReady) setupEnRoute();
  resolveStation();
  const q = $("search").value.trim().toLowerCase();
  const station = stationSel != null ? stationTableHTML(stationSel, q) : '<p class="manifest-hint">Cherche une station ci-dessus pour voir et corriger ses prix et stocks.</p>';
  $("correctionsStation").innerHTML = station;
  $("correctionsList").innerHTML = correctionsListHTML() + autoloadListHTML();
  notifySuperseded();
}

// ---------- Vue « Commodités » : grand tableau + tous les points d'achat/vente ----------
// Tri du tableau : 3 modes prédéfinis (boutons) + tri par colonne (clic en-tête).
function sortCommodities(rows) {
  // La « valeur » d'une tuile dépend du board : marge en Marché, prix de revente en Butin.
  const vk = commBoard === "loot" ? "bestSell" : "margin";
  if (commMode === "margin") return rows.sort(bySort(vk, -1));                        // plus lucratif d'abord
  if (commMode === "code") return rows.sort(bySort("code", 1));                        // code A→Z
  if (commMode === "kind")                                                             // catégorie puis valeur
    return rows.sort((a, b) => (a.kind || "").localeCompare(b.kind || "", "fr") || (b[vk] ?? -Infinity) - (a[vk] ?? -Infinity));
  return rows.sort(bySort(commSortKey, commSortDir));                                  // colonne (mode custom)
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
  // Le code ne sert d'étiquette que s'il identifie SA commodité ; sinon on retombe sur le nom
  // (tronqué par CSS), seul moyen de distinguer deux tuiles qui partagent un code UEX.
  const label = c.code && !commDupCodes.has(c.code) ? c.code : c.name;
  return `<button class="${cls}" data-name="${esc(c.name)}" title="${esc(title)}">
      <span class="tile-code">${carried ? '<span class="tile-carried" title="Dans ton voyage">◆</span>' : ""}${esc(label)}</span>
      <span class="tile-val">${val == null ? "—" : compactValue(val)}</span>
    </button>`;
}

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
  // `effVals` : le détail affiche les valeurs CORRIGÉES, comme les tableaux. Et puisqu'elles le
  // sont, elles passent par `editv` — le même composant qu'ailleurs : marqueur ✎ sur ce qui est
  // corrigé, et clic pour corriger sur place. Le board devient ainsi le point d'entrée naturel
  // pour rectifier un prix « chez toutes les stations qui vendent cette commodité ».
  const p = commodityPoints(MARKET, commSelected, readFilters(), effVals); // avant-postes exclus si le filtre est actif
  if (!p) { box.innerHTML = ""; return; }
  const cell = (terminal, side, field, value, updated) =>
    editv(p.name, terminal, side, field, value, isOv(p.name, terminal, side, field), updated);
  const buyRow = (b) => `<tr><td class="loc"><div>${esc(b.terminal)}${sysBadge(b.system)}${outpostTag(b.outpost)}</div><div class="loc-sub">${esc(b.planet)}</div></td><td class="num">${cell(b.terminal, "buy", "price", b.price, b.updated)}</td><td class="num">${statusDot(b.status, "buy")} ${cell(b.terminal, "buy", "vol", b.stock, b.updated)}</td><td>${freshChip(b.updated)}</td></tr>`;
  const sellRow = (s) => `<tr><td class="loc"><div>${esc(s.terminal)}${sysBadge(s.system)}${outpostTag(s.outpost)}</div><div class="loc-sub">${esc(s.planet)}</div></td><td class="num">${cell(s.terminal, "sell", "price", s.price, s.updated)}</td><td class="num">${statusDot(s.status, "sell")} ${cell(s.terminal, "sell", "vol", s.demand, s.updated)}</td><td>${freshChip(s.updated)}</td></tr>`;
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

function renderCommodities() {
  if (!MARKET) { withMarket(refresh); return; }
  if (!enrouteReady) setupEnRoute();
  const f = { ...readFilters(), board: commBoard };
  const q = f.q;
  // `effVals` : marge, couleur de tuile et rang suivent les corrections locales. Sans lui, la tuile
  // continuait d'afficher la marge d'UEX après qu'on ait corrigé le prix dans un tableau.
  const all = commoditySummaries(MARKET, f, effVals); // légales + avant-postes + board s'appliquent ici
  // Les DEUX heatmaps se calculent sur TOUT le board, jamais sur le sous-ensemble visible : la
  // couleur d'une tuile prétend situer la commodité dans l'ensemble du marché. Calculée après le
  // filtre de recherche, taper « iron » suffisait à repeindre Iron (3 900 aUEC/SCU, le bas du
  // classement) en `t-hot`, le palier réservé aux 15 % les mieux payés — rang 0 sur 1 ligne restante.
  commMaxMargin = all.reduce((mx, c) => Math.max(mx, c.margin || 0), 0); // heatmap relative (Marché)
  commTiers = commBoard === "loot" ? valueTiers(all) : new Map();        // heatmap par rang (Butin)
  const rows = all.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || (c.code && c.code.toLowerCase().includes(q))
  );
  sortCommodities(rows);
  shownCommodities = rows;
  commDupCodes = ambiguousCodes(rows);                                    // codes UEX non discriminants
  commCarried = journeyCarriedCommodities(); // commodités du voyage à surligner
  // Sélection : garde la commodité choisie si toujours visible, sinon prend la 1re.
  if (commSelected && !rows.some((r) => r.name === commSelected)) commSelected = null;
  if (!commSelected && rows.length) commSelected = rows[0].name;
  $("commGrid").innerHTML = rows.map(commodityTileHTML).join("");
  // Bouton de mode de tri actif.
  document.querySelectorAll("#commSortModes button").forEach((b) => b.classList.toggle("active", b.dataset.sort === commMode));
  syncCommBoardUI();
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
  // Multi-commodité : remplir la soute n'a pas de sens sans soute bornée -> coche grisée.
  $("multiCommodity").disabled = cargoOff;
  $("multiCommodityLabel").classList.toggle("disabled", cargoOff);
  // Frais d'autoload : le coefficient global n'a de sens que l'interrupteur actif -> champ masqué
  // sinon (il reste dans l'état, donc dans le lien). La coche, elle, n'est PAS grisée sans soute :
  // le budget ou le plafond de stock bornent aussi le volume, et un volume borné suffit à facturer.
  $("alkField").hidden = !$("autoload").checked;
  // Portée de la liste multi : ne se règle que si la liste multi existe.
  $("multiModeField").hidden = !$("multiCommodity").checked;
}

async function init() {
  setupSort();
  setupLoopSort();
  applySortIndicators(); // aria-sort/classes du tri par défaut, sans dépendre des attributs du HTML
  // Les champs à SAISIE LIBRE sont débouncés : sans ça, chaque caractère relançait un cycle
  // complet calcul + réécriture de #rows par innerHTML. Mesuré à ~142 ms par frappe sur un CPU
  // throttlé ×4 (le coût dominant est le relayout de la table, pas le calcul : ~2 ms), soit plus
  // d'une seconde de thread bloqué pour taper « Laranite », et deux recalculs sur des valeurs
  // absurdes quand on tape « 696 » dans la soute (6 puis 69 SCU).
  // Menus et cases à cocher restent IMMÉDIATS : ils n'émettent qu'un seul événement.
  ["cargo", "budget", "search", "alk"].forEach((id) => $(id).addEventListener("input", refreshDebounced));
  ["system", "freshness", "sameSystem", "noOutpost", "legalOnly", "capStock", "multiMode"].forEach((id) =>
    $(id).addEventListener("input", refresh)
  );
  // Ces deux-là commandent en plus l'affichage de leur propre sous-réglage (coefficient k, portée
  // de la liste multi) : ils passent donc par syncToggles avant de recalculer.
  ["autoload", "multiCommodity"].forEach((id) =>
    $(id).addEventListener("input", () => { syncToggles(); refresh(); })
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
  $("commBoardModes").addEventListener("click", (e) => { const b = e.target.closest("button[data-board]"); if (b) setCommBoard(b.dataset.board); });
  $("commGrid").addEventListener("click", (e) => {
    const tile = e.target.closest(".comm-tile");
    if (!tile) return;
    commSelected = tile.dataset.name;
    document.querySelectorAll("#commGrid .comm-tile").forEach((t) => t.classList.toggle("selected", t.dataset.name === commSelected));
    paintCommodityDetail();
    saveState();
  });
  // Contrôles « En route ». Ces champs de terminal sont eux aussi à SAISIE LIBRE (datalist, mais
  // rien n'oblige à choisir dans la liste) : même debounce que ci-dessus. Sans lui, chaque frappe
  // re-rendait la vue ET réécrivait le hash — or WebKit plafonne history.replaceState à 100 appels
  // par 10 s : taper deux noms de terminal suffisait à le franchir. Les résolveurs restent DANS le
  // rappel, donc dans le même ordre qu'avant ; renderEnRoute / renderChain / renderCorrections les
  // rejouent de toute façon avant de peindre.
  $("origin").addEventListener("input", debounce(() => { resolveOrigin(); refresh(); }));
  $("destSystem").addEventListener("input", refresh); // <select> : un seul événement, immédiat
  $("destTerminal").addEventListener("input", refreshDebounced); // terminal d'arrivée forcé
  // Contrôles « Chaîne ».
  $("chainOrigin").addEventListener("input", debounce(() => { resolveChainOrigin(); refresh(); }));
  $("hops").addEventListener("input", refresh);
  // Contrôles « Corrections » : recherche de station + suppression / reset (délégué).
  $("station").addEventListener("input", debounce(() => { resolveStation(); refresh(); }));
  $("corrections").addEventListener("click", (e) => {
    // Les relevés d'autoload se testent AVANT les corrections : leur ✕ porte aussi `.corr-del`
    // (même bouton à l'écran) et tomberait sinon dans la branche qui écrit dans OVERRIDES.
    const alDel = e.target.closest(".al-del");
    if (alDel) { forgetStationReading(alDel.dataset.key); return; }
    const del = e.target.closest(".corr-del");
    if (del) {
      // Supprimer une correction de volume rend le stock d'UEX : c'est encore un changement de
      // volume, donc la même règle s'applique — le voyage déjà planifié ne doit pas s'y rebattre.
      const cle = del.dataset.key;
      if (OVERRIDES[cle] && OVERRIDES[cle].vol != null) {
        const [commodity, terminal, side] = cle.split("|");
        pinLegsForVolume(commodity, terminal, side);
      }
      delete OVERRIDES[cle]; saveOverrides(); updateOvBadge(); refresh(); return;
    }
    if (e.target.closest("#alSave")) { saveStationReading(); return; }
    if (e.target.closest("#resetAllK")) { resetAllReadings(); return; }
    if (e.target.closest("#resetAll")) resetAllOverrides();
  });
  // Validation du relevé d'autoload à la touche Entrée (les deux champs sont dans le même panneau).
  $("corrections").addEventListener("keydown", (e) => {
    if ((e.target.id === "alAmount" || e.target.id === "alScu") && e.key === "Enter") { e.preventDefault(); saveStationReading(); }
  });
  // Manifeste : ajustement des SCU + ajout (suggéré ou libre) + retrait d'une ligne.
  $("manifest").addEventListener("input", (e) => {
    if (e.target.classList.contains("mqty-input")) updateManifestTotals();
  });
  $("manifest").addEventListener("click", (e) => {
    // Ici et pas dans le délégué global du compagnon : celui-ci lit `pick.closest("table").id`,
    // qui lèverait un TypeError depuis une carte. La carte n'est pas un tableau.
    if (e.target.closest("#manifestToJourney")) { manifestToJourney(); return; }
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
    const multi = tableId === "routes" && isMultiRoutes();
    const arr = tableId === "loops" ? shownLoops : tableId === "enroute" ? shownEnroute : multi ? shownMulti : shownRoutes;
    const item = arr[Number(btn.dataset.row)];
    if (!item) return;
    const html = tableId === "loops" ? loopSchemaHTML(item) : multi ? multiSchemaHTML(item) : routeSchemaHTML(item);
    tr.insertAdjacentHTML("afterend", `<tr class="schema-row"><td colspan="${tr.children.length}">${html}</td></tr>`);
    btn.classList.add("open");
  });
  // Carte du parcours : cliquer une escale déplace « je suis ici », comme le fil d'étapes.
  $("holdCard").addEventListener("click", (e) => {
    if (e.target.closest("#holdClear")) { viderSoute(); return; }
    if (e.target.closest("#holdOffload")) { ecoulerOuvert = !ecoulerOuvert; renderSoute(); return; }
    const deposer = e.target.closest(".hold-store");
    if (deposer) { deposerIci(deposer.dataset.name, Number(deposer.closest(".hold-sell").querySelector(".hold-sell-qty").value)); return; }
    const ouvrir = e.target.closest(".hold-sell-btn");
    if (ouvrir) { venteEnCours = ouvrir.dataset.name; renderSoute(); $("holdCard").querySelector(".hold-sell-qty")?.select(); return; }
    if (e.target.closest(".hold-sell-no")) { venteEnCours = null; renderSoute(); return; }
    const ok = e.target.closest(".hold-sell-ok");
    if (ok) { vendreIci(ok.dataset.name, Number(ok.closest(".hold-sell").querySelector(".hold-sell-qty").value)); return; }
    const del = e.target.closest(".hold-del");
    if (del) retirerLot(Number(del.dataset.i));
  });
  // Entrée valide la vente, Échap l'annule — même patron que les corrections inline.
  $("holdCard").addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("hold-sell-qty")) return;
    if (e.key === "Enter") { e.preventDefault(); vendreIci(venteEnCours, Number(e.target.value)); }
    else if (e.key === "Escape") { e.preventDefault(); venteEnCours = null; renderSoute(); }
  });
  $("journeyMap").addEventListener("click", (e) => {
    const a = e.target.closest(".jm-arret");
    if (a) setJourneyStop(Number(a.dataset.i));
  });
  $("journeyMap").addEventListener("keydown", (e) => {
    const a = e.target.closest(".jm-arret");
    if (a && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setJourneyStop(Number(a.dataset.i)); }
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
      else if (tableId === "routes" && isMultiRoutes()) { const t = shownMulti[i]; if (t) pickJourney([legFromTrip(t)]); }
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
    const load = e.target.closest(".jleg-load");
    if (load) { chargerJambe(Number(load.dataset.leg)); return; } // AVANT .jleg-head : le bouton y vit
    if (e.target.closest(".jman-reset")) { resetLeg(Number(e.target.closest(".jman-reset").dataset.leg)); return; }
    const addBtn = e.target.closest(".jman-add-btn");
    if (addBtn) { addLegLine(Number(addBtn.dataset.leg), addBtn.closest(".jman-add").querySelector(".jman-add-input").value); return; }
    const head = e.target.closest(".jleg-head");
    if (head) { toggleLegEditor(Number(head.dataset.leg)); return; }
    // Parcours interactif : clic sur une étape (⦿) = « je suis ici » -> recale les vues.
    const step = e.target.closest(".jstep");
    if (step) setJourneyStop(Number(step.dataset.i));
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
      else withMarket(() => {});
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
  loadAutoloadK();
  loadJourneyEdits();
  loadJourneyPins();
  loadSoute();
  loadDepots();
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
    // Le compagnon de voyage vient d'un permalien, donc de données non fiables. S'il échoue, il ne
    // doit pas emporter TOUTE l'app dans le catch ci-dessous, qui accuserait alors data/routes.json
    // — parfaitement chargé — et laisserait l'utilisateur devant une page vide et un message faux.
    try {
      renderJourney();
    } catch (err) {
      JOURNEY = null;
      renderJourney();
      showToast("⚠ Parcours illisible dans le lien — il a été ignoré");
    }
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
