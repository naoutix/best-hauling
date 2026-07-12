"use strict";

// État global
let ROUTES = [];
let LOOPS = [];
let view = "routes"; // "routes" | "loops"
let sortKey = "profitHour";
let sortDir = -1; // -1 = décroissant, 1 = croissant
let loopSortKey = "profit";
let loopSortDir = -1;

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString("fr-FR"));

// Formatte le nom d'un système en badge coloré.
function sysBadge(system) {
  const cls = system.toLowerCase();
  return `<span class="sys ${cls}">${system}</span>`;
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
  return `<span class="cicon k-${k}" title="${k}">${emoji}</span>`;
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

// Comparateur de tri qui renvoie toujours les valeurs nulles en bas.
function bySort(key, dir) {
  return (a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av > bv ? dir : av < bv ? -dir : 0;
  };
}

// Calcule les champs dérivés d'une route selon les entrées utilisateur.
// useCargo / useBudget désactivent la contrainte correspondante (limite = illimitée).
function evaluate(r, cargo, budget, capStock, useCargo, useBudget) {
  const byCargo = useCargo ? cargo : Infinity;
  const byBudget = useBudget && budget > 0 ? Math.floor(budget / r.buy.price) : Infinity;
  let units = Math.min(byCargo, byBudget);
  if (capStock) {
    if (r.buy.stock > 0) units = Math.min(units, r.buy.stock); // stock dispo à l'achat
    if (r.sell.demand > 0) units = Math.min(units, r.sell.demand); // demande à la vente
  }
  // Aucune contrainte de volume active -> valeurs par voyage non définies (on classe alors par marge).
  const bounded = isFinite(units);
  if (bounded && units < 0) units = 0;
  const profit = bounded ? units * r.margin : null;
  const minutes = tripMinutes(r.distance, !r.same_system);
  return {
    ...r,
    buyPrice: r.buy.price,
    sellPrice: r.sell.price,
    units: bounded ? units : null,
    investment: bounded ? units * r.buy.price : null,
    profit,
    minutes,
    profitHour: profit == null ? null : (profit * 60) / minutes,
  };
}

function render() {
  const cargo = Math.max(0, Number($("cargo").value) || 0);
  const budget = Math.max(0, Number($("budget").value) || 0);
  const capStock = $("capStock").checked;
  const useCargo = $("useCargo").checked;
  const useBudget = $("useBudget").checked;
  const sameOnly = $("sameSystem").checked;
  const noOutpost = $("noOutpost").checked;
  const legalOnly = $("legalOnly").checked;
  const sysFilter = $("system").value;
  const q = $("search").value.trim().toLowerCase();

  let rows = ROUTES.filter((r) => {
    if (sameOnly && !r.same_system) return false;
    if (noOutpost && (r.buy.outpost || r.sell.outpost)) return false;
    if (legalOnly && r.illegal) return false;
    if (sysFilter && r.buy.system !== sysFilter) return false;
    if (q && !r.commodity.toLowerCase().includes(q)) return false;
    return true;
  }).map((r) => evaluate(r, cargo, budget, capStock, useCargo, useBudget));

  rows.sort(bySort(sortKey, sortDir));

  const tbody = $("rows");
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="loc"><div class="commodity-cell">${commodityIcon(r.kind)}<span>${r.commodity}${illegalTag(r.illegal)}</span></div></td>
        <td>
          <div>${r.buy.terminal}${sysBadge(r.buy.system)}${outpostTag(r.buy.outpost)}</div>
          <div class="loc-sub">${r.buy.planet} · ${fmt(r.buy.price)} aUEC · <span class="stock" title="Stock disponible à l'achat (relevé UEX)">stock ${fmt(r.buy.stock)} SCU</span></div>
        </td>
        <td>
          <div>${r.sell.terminal}${sysBadge(r.sell.system)}${outpostTag(r.sell.outpost)}</div>
          <div class="loc-sub">${r.sell.planet} · ${fmt(r.sell.price)} aUEC · <span class="stock" title="Demande / stock à la vente (relevé UEX)">demande ${fmt(r.sell.demand)} SCU</span>${r.same_system ? "" : ' <span class="cross">⚡ saut inter-système</span>'}</div>
        </td>
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
function evaluateLoop(l, cargo, budget, capStock, useCargo, useBudget) {
  const legUnits = (leg) => {
    const byCargo = useCargo ? cargo : Infinity;
    const byBudget = useBudget && budget > 0 ? Math.floor(budget / leg.buyPrice) : Infinity;
    let u = Math.min(byCargo, byBudget);
    if (capStock) {
      if (leg.stock > 0) u = Math.min(u, leg.stock); // stock dispo à l'achat
      if (leg.demand > 0) u = Math.min(u, leg.demand); // demande à la destination
    }
    return u;
  };
  const uOut = legUnits(l.out), uBack = legUnits(l.back);
  const bounded = isFinite(uOut) && isFinite(uBack);
  const cross = l.a.system !== l.b.system;
  const minutes = loopMinutes(l.distance, cross);
  const profit = bounded ? uOut * l.out.margin + uBack * l.back.margin : null;
  return {
    ...l,
    cross,
    unitsOut: bounded ? uOut : null,
    unitsBack: bounded ? uBack : null,
    units: bounded ? uOut + uBack : null,
    investment: bounded ? Math.max(uOut * l.out.buyPrice, uBack * l.back.buyPrice) : null,
    profit,
    minutes,
    profitHour: profit == null ? null : (profit * 60) / minutes,
  };
}

function renderLoops() {
  const cargo = Math.max(0, Number($("cargo").value) || 0);
  const budget = Math.max(0, Number($("budget").value) || 0);
  const capStock = $("capStock").checked;
  const useCargo = $("useCargo").checked;
  const useBudget = $("useBudget").checked;
  const sameOnly = $("sameSystem").checked;
  const noOutpost = $("noOutpost").checked;
  const legalOnly = $("legalOnly").checked;
  const sysFilter = $("system").value;
  const q = $("search").value.trim().toLowerCase();

  let rows = LOOPS.filter((l) => {
    if (sameOnly && l.a.system !== l.b.system) return false;
    if (noOutpost && (l.a.outpost || l.b.outpost)) return false;
    if (legalOnly && (l.out.illegal || l.back.illegal)) return false;
    if (sysFilter && l.a.system !== sysFilter && l.b.system !== sysFilter) return false;
    if (q && !(l.out.commodity.toLowerCase().includes(q) || l.back.commodity.toLowerCase().includes(q))) return false;
    return true;
  }).map((l) => evaluateLoop(l, cargo, budget, capStock, useCargo, useBudget));

  rows.sort(bySort(loopSortKey, loopSortDir));

  $("loopRows").innerHTML = rows
    .map(
      (l) => `
      <tr>
        <td class="loc">
          <div>${l.a.terminal}${sysBadge(l.a.system)}${outpostTag(l.a.outpost)}</div>
          <div class="loc-sub">⇄ ${l.b.terminal}${sysBadge(l.b.system)}${outpostTag(l.b.outpost)}${l.cross ? ' <span class="cross">⚡ inter-système</span>' : ""}</div>
        </td>
        <td>
          <div class="commodity-cell">${commodityIcon(l.out.kind)}<span>${l.out.commodity}${illegalTag(l.out.illegal)}</span></div>
          <div class="loc-sub">${fmt(l.out.buyPrice)} → ${fmt(l.out.sellPrice)} · marge ${fmt(l.out.margin)}</div>
        </td>
        <td>
          <div class="commodity-cell">${commodityIcon(l.back.kind)}<span>${l.back.commodity}${illegalTag(l.back.illegal)}</span></div>
          <div class="loc-sub">${fmt(l.back.buyPrice)} → ${fmt(l.back.sellPrice)} · marge ${fmt(l.back.margin)}</div>
        </td>
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
    });
  });
}

// Charge les vaisseaux et gère une autocomplétion maison (filtre par sous-chaîne,
// fiable sur tous les navigateurs, avec navigation clavier).
async function loadShips() {
  const ships = await fetch("data/ships.json").then((r) => r.json()).catch(() => []);
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

  function show(q) {
    matches = ships.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 12);
    if (!matches.length) return hide();
    active = 0;
    list.innerHTML = matches
      .map(
        (s, i) =>
          `<li role="option" data-i="${i}" class="${i === 0 ? "active" : ""}">` +
          `<span>${s.name}</span><span class="scu">${s.scu.toLocaleString("fr-FR")} SCU</span></li>`
      )
      .join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function showCard(s) {
    const card = $("shipCard");
    const img = $("shipImg");
    const wrap = img.parentElement;
    if (s.photo) {
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

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    q ? show(q) : hide();
  });

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
  ["cargo", "budget", "search", "system", "sameSystem", "noOutpost", "legalOnly", "capStock"].forEach((id) =>
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
  syncToggles();

  try {
    const [routes, loops, meta] = await Promise.all([
      fetch("data/routes.json").then((r) => r.json()),
      fetch("data/loops.json").then((r) => r.json()).catch(() => []),
      fetch("data/meta.json").then((r) => r.json()).catch(() => null),
      loadShips(),
    ]);
    ROUTES = routes;
    LOOPS = loops;

    // Remplit le filtre système.
    const systems = [...new Set(routes.map((r) => r.buy.system))].sort();
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
    refresh();
  } catch (e) {
    $("meta").textContent = "Erreur de chargement des données.";
    $("empty").hidden = false;
    $("empty").textContent = "Impossible de charger data/routes.json — lance le script de mise à jour.";
    console.error(e);
  }
}

init();
