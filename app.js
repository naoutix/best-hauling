"use strict";

// État global
let ROUTES = [];
let sortKey = "profit";
let sortDir = -1; // -1 = décroissant, 1 = croissant

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString("fr-FR");

// Formatte le nom d'un système en badge coloré.
function sysBadge(system) {
  const cls = system.toLowerCase();
  return `<span class="sys ${cls}">${system}</span>`;
}

// Calcule les champs dérivés d'une route selon les entrées utilisateur.
function evaluate(r, cargo, budget, capStock) {
  const affordable = budget > 0 ? Math.floor(budget / r.buy.price) : Infinity;
  let units = Math.min(cargo, affordable);
  if (capStock && r.buy.stock > 0) units = Math.min(units, r.buy.stock);
  if (!isFinite(units) || units < 0) units = 0;
  return {
    ...r,
    buyPrice: r.buy.price,
    sellPrice: r.sell.price,
    units,
    investment: units * r.buy.price,
    profit: units * r.margin,
  };
}

function render() {
  const cargo = Math.max(0, Number($("cargo").value) || 0);
  const budget = Math.max(0, Number($("budget").value) || 0);
  const capStock = $("capStock").checked;
  const sameOnly = $("sameSystem").checked;
  const sysFilter = $("system").value;
  const q = $("search").value.trim().toLowerCase();

  let rows = ROUTES.filter((r) => {
    if (sameOnly && !r.same_system) return false;
    if (sysFilter && r.buy.system !== sysFilter) return false;
    if (q && !r.commodity.toLowerCase().includes(q)) return false;
    return true;
  }).map((r) => evaluate(r, cargo, budget, capStock));

  rows.sort((a, b) => (a[sortKey] > b[sortKey] ? sortDir : a[sortKey] < b[sortKey] ? -sortDir : 0));

  const tbody = $("rows");
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="loc">${r.commodity}</td>
        <td>
          <div>${r.buy.terminal}${sysBadge(r.buy.system)}</div>
          <div class="loc-sub">${r.buy.planet} · ${fmt(r.buy.price)} aUEC</div>
        </td>
        <td>
          <div>${r.sell.terminal}${sysBadge(r.sell.system)}</div>
          <div class="loc-sub">${r.sell.planet} · ${fmt(r.sell.price)} aUEC${r.same_system ? "" : ' <span class="cross">⚡ saut inter-système</span>'}</div>
        </td>
        <td class="num">${fmt(r.margin)}</td>
        <td class="num roi-badge">${r.roi}%</td>
        <td class="num">${fmt(r.units)}</td>
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

async function init() {
  setupSort();
  ["cargo", "budget", "search", "system", "sameSystem", "capStock"].forEach((id) =>
    $(id).addEventListener("input", render)
  );

  try {
    const [routes, meta] = await Promise.all([
      fetch("data/routes.json").then((r) => r.json()),
      fetch("data/meta.json").then((r) => r.json()).catch(() => null),
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
