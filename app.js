"use strict";

// État global
let ROUTES = [];
let sortKey = "profit";
let sortDir = -1; // -1 = décroissant, 1 = croissant

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

// Calcule les champs dérivés d'une route selon les entrées utilisateur.
// useCargo / useBudget désactivent la contrainte correspondante (limite = illimitée).
function evaluate(r, cargo, budget, capStock, useCargo, useBudget) {
  const byCargo = useCargo ? cargo : Infinity;
  const byBudget = useBudget && budget > 0 ? Math.floor(budget / r.buy.price) : Infinity;
  let units = Math.min(byCargo, byBudget);
  if (capStock && r.buy.stock > 0) units = Math.min(units, r.buy.stock);
  // Aucune contrainte de volume active -> valeurs par voyage non définies (on classe alors par marge).
  const bounded = isFinite(units);
  if (bounded && units < 0) units = 0;
  return {
    ...r,
    buyPrice: r.buy.price,
    sellPrice: r.sell.price,
    units: bounded ? units : null,
    investment: bounded ? units * r.buy.price : null,
    profit: bounded ? units * r.margin : null,
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
  const sysFilter = $("system").value;
  const q = $("search").value.trim().toLowerCase();

  let rows = ROUTES.filter((r) => {
    if (sameOnly && !r.same_system) return false;
    if (noOutpost && (r.buy.outpost || r.sell.outpost)) return false;
    if (sysFilter && r.buy.system !== sysFilter) return false;
    if (q && !r.commodity.toLowerCase().includes(q)) return false;
    return true;
  }).map((r) => evaluate(r, cargo, budget, capStock, useCargo, useBudget));

  // Tri : les valeurs nulles (contraintes désactivées) vont toujours en bas.
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av > bv ? sortDir : av < bv ? -sortDir : 0;
  });

  const tbody = $("rows");
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="loc">${r.commodity}</td>
        <td>
          <div>${r.buy.terminal}${sysBadge(r.buy.system)}${outpostTag(r.buy.outpost)}</div>
          <div class="loc-sub">${r.buy.planet} · ${fmt(r.buy.price)} aUEC</div>
        </td>
        <td>
          <div>${r.sell.terminal}${sysBadge(r.sell.system)}${outpostTag(r.sell.outpost)}</div>
          <div class="loc-sub">${r.sell.planet} · ${fmt(r.sell.price)} aUEC${r.same_system ? "" : ' <span class="cross">⚡ saut inter-système</span>'}</div>
        </td>
        <td class="num">${fmt(r.margin)}</td>
        <td class="num roi-badge">${r.roi}%</td>
        <td class="num">${fmt(r.units)}</td>
        <td class="num">${fmt(r.investment)}</td>
        <td class="num profit">${fmt(r.profit)}</td>
      </tr>`
    )
    .join("");

  $("empty").hidden = rows.length > 0;
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
      document.querySelectorAll("th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(sortDir === -1 ? "sorted-desc" : "sorted-asc");
      render();
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

  function choose(s) {
    if (!s) return;
    input.value = s.name;
    $("cargo").value = s.scu;
    hide();
    render();
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

  // Modifier la soute à la main efface le nom du vaisseau.
  $("cargo").addEventListener("input", () => {
    const scu = byName.get(input.value.trim().toLowerCase());
    if (String(scu) !== $("cargo").value) input.value = "";
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
  ["cargo", "budget", "search", "system", "sameSystem", "noOutpost", "capStock"].forEach((id) =>
    $(id).addEventListener("input", render)
  );
  ["useCargo", "useBudget"].forEach((id) =>
    $(id).addEventListener("change", () => {
      syncToggles();
      render();
    })
  );
  syncToggles();

  try {
    const [routes, meta] = await Promise.all([
      fetch("data/routes.json").then((r) => r.json()),
      fetch("data/meta.json").then((r) => r.json()).catch(() => null),
      loadShips(),
    ]);
    ROUTES = routes;

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
        `<b>${meta.routes}</b> routes · <b>${meta.commodities}</b> commodités<br>` +
        `Mis à jour le ${d.toLocaleString("fr-FR")}`;
    }
    render();
  } catch (e) {
    $("meta").textContent = "Erreur de chargement des données.";
    $("empty").hidden = false;
    $("empty").textContent = "Impossible de charger data/routes.json — lance le script de mise à jour.";
    console.error(e);
  }
}

init();
