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

// ---------- Unités achetables selon les contraintes actives ----------
// f = { cargo, budget, capStock, useCargo, useBudget }. Infinity si aucune contrainte de volume.
export function computeUnits(price, stock, demand, f) {
  const byCargo = f.useCargo ? f.cargo : Infinity;
  const byBudget = f.useBudget && f.budget > 0 ? Math.floor(f.budget / price) : Infinity;
  let units = Math.min(byCargo, byBudget);
  if (f.capStock) {
    if (stock > 0) units = Math.min(units, stock);
    if (demand > 0) units = Math.min(units, demand);
  }
  if (isFinite(units) && units < 0) units = 0;
  return units;
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
    if (it.stock > 0) u = Math.min(u, it.stock);
    if (it.demand > 0) u = Math.min(u, it.demand);
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

// ---------- Unités ajoutables d'une commodité candidate (suggestions) ----------
export function addableUnits(it, rem) {
  let u = rem.cargoLeft;
  if (it.stock > 0) u = Math.min(u, it.stock);
  if (it.demand > 0) u = Math.min(u, it.demand);
  if (isFinite(rem.budgetLeft)) u = Math.min(u, Math.floor(rem.budgetLeft / it.buyPrice));
  return Math.max(0, u);
}
