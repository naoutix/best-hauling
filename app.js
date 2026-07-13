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

// Calcule les champs dérivés d'une route selon les entrées utilisateur.
function evaluate(r, f) {
  const units = computeUnits(r.buy.price, r.buy.stock, r.sell.demand, f);
  const bounded = isFinite(units);
  const profit = bounded ? units * r.margin : null;
  const minutes = tripMinutes(r.distance, !r.same_system);
  const profitHour = profit == null ? null : (profit * 60) / minutes;
  const base = profit == null ? r.margin : profitHour;
  const rawScore =
    base * freshnessFactor(pairAge(r.buy.updated, r.sell.updated)) * availabilityFactor(r.buy.stock, r.sell.demand);
  return {
    ...r,
    buyPrice: r.buy.price,
    sellPrice: r.sell.price,
    units: bounded ? units : null,
    investment: bounded ? units * r.buy.price : null,
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

  const tbody = $("rows");
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="loc"><div class="commodity-cell">${commodityIcon(r.kind)}<span>${esc(r.commodity)}${illegalTag(r.illegal)}${suspectTag(r)}</span></div></td>
        <td>
          <div>${esc(r.buy.terminal)}${sysBadge(r.buy.system)}${outpostTag(r.buy.outpost)}</div>
          <div class="loc-sub">${esc(r.buy.planet)} · ${fmt(r.buy.price)} aUEC · ${statusDot(r.buy.status, "buy")}<span class="stock" title="Stock disponible à l'achat (relevé UEX)">stock ${fmt(r.buy.stock)} SCU</span> · ${freshChip(r.buy.updated)}</div>
        </td>
        <td>
          <div>${esc(r.sell.terminal)}${sysBadge(r.sell.system)}${outpostTag(r.sell.outpost)}</div>
          <div class="loc-sub">${esc(r.sell.planet)} · ${fmt(r.sell.price)} aUEC · ${statusDot(r.sell.status, "sell")}<span class="stock" title="Demande / stock à la vente (relevé UEX)">demande ${fmt(r.sell.demand)} SCU</span> · ${freshChip(r.sell.updated)}${r.same_system ? "" : ' <span class="cross">⚡ saut inter-système</span>'}</div>
        </td>
        <td>${scoreCell(r.score)}</td>
        <td class="num">${fmt(r.margin)}</td>
        <td class="num roi-badge">${r.roi}%</td>
        <td class="num">${fmt(r.units)}</td>
        <td class="num">${fmt(r.investment)}</td>
        <td class="num profit">${fmt(r.profit)}</td>
        <td class="num profit" title="Estimation ${Math.round(r.minutes)} min/voyage">${fmt(r.profitHour)}</td>
      </tr>`
    )
    .join("");

  $("empty").hidden = rows.length > 0;
}

// ---------- Vue "Boucles aller-retour" ----------
function evaluateLoop(l, f) {
  const uOut = computeUnits(l.out.buyPrice, l.out.stock, l.out.demand, f);
  const uBack = computeUnits(l.back.buyPrice, l.back.stock, l.back.demand, f);
  const bounded = isFinite(uOut) && isFinite(uBack);
  const cross = l.a.system !== l.b.system;
  const minutes = loopMinutes(l.distance, cross);
  const profit = bounded ? uOut * l.out.margin + uBack * l.back.margin : null;
  const profitHour = profit == null ? null : (profit * 60) / minutes;
  const base = profit == null ? l.loopMargin : profitHour;
  const rawScore =
    base *
    freshnessFactor(pairAge(l.out.updated, l.back.updated)) *
    availabilityFactor(Math.min(l.out.stock, l.back.stock), Math.min(l.out.demand, l.back.demand));
  return {
    ...l,
    cross,
    unitsOut: bounded ? uOut : null,
    unitsBack: bounded ? uBack : null,
    units: bounded ? uOut + uBack : null,
    investment: bounded ? Math.max(uOut * l.out.buyPrice, uBack * l.back.buyPrice) : null,
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

// Bascule entre les deux vues et rafraîchit la bonne table.
function refresh() {
  if (view === "loops") renderLoops();
  else render();
  saveState();
}
function switchView(v) {
  view = v;
  $("viewRoutes").classList.toggle("active", v === "routes");
  $("viewLoops").classList.toggle("active", v === "loops");
  $("routes").hidden = v !== "routes";
  $("loops").hidden = v !== "loops";
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
const STATE_FIELDS = ["cargo", "budget", "search", "system", "freshness", "ship"];
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
  if (s.v === "routes" || s.v === "loops") view = s.v;
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
  $("share").addEventListener("click", copyShareLink);
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

    // Remplit le filtre système (systèmes d'achat ET de vente, pour n'en oublier aucun).
    const systems = [...new Set(routes.flatMap((r) => [r.buy.system, r.sell.system]))].sort();
    const sel = $("system");
    systems.forEach((s) => {
      const o = document.createElement("option");
      o.value = o.textContent = s;
      sel.appendChild(o);
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
