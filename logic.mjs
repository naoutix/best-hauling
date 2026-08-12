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
// `demand` null = capacité inconnue chez UEX (`scu_sell` n'est renseigné que sur une minorité
// de points de vente) : on ne juge alors que le stock, comme le fait déjà `computeUnits` qui
// n'applique aucun plafond dans ce cas. Un 0 CONNU reste une saturation -> pénalité maximale.
export function availabilityFactor(stock, demand) {
  const s = stock || 0;
  if (demand == null) return s ? volumeFactor(s) : 0.65;
  if (!s && !demand) return 0.65;
  return volumeFactor(Math.min(s, demand));
}
// Saturation douce d'un volume : 0.3 à vide -> 1.0 asymptotique (0.65 à 120 SCU).
function volumeFactor(m) {
  return 0.3 + 0.7 * (m / (m + 120));
}
// Volume le plus contraignant de deux segments, en ignorant les capacités inconnues
// (`Math.min(null, x)` vaudrait 0 et ferait passer un segment inconnu pour saturé).
export function tighterVolume(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
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
    // Demande à la vente = capacité restante du terminal. null = capacité inconnue chez UEX
    // (pas de plafond) ; 0 CONNU = terminal saturé, il ne prend plus rien -> plafonne à 0.
    if (demand != null || demandKnown) units = Math.min(units, demand);
  }
  if (isFinite(units) && units < 0) units = 0;
  return units;
}

// ---------- Champs dérivés d'un trajet (unités, profit, temps, score) ----------
// Cœur de calcul PUR d'une route dont les prix/volumes sont déjà résolus (corrections appliquées
// en amont). m = { buyPrice, buyStock, sellDemand, margin, distance, sameSystem, buyUpdated,
// sellUpdated, demandKnown }. Renvoie units/investment (null si non bornés) + profit/minutes/
// profitHour/rawScore. `evaluate` (app.js) applique d'abord les corrections puis délègue ici.
// `autoload` = { buy, sell } (points de frais résolus par l'appelant, qui seul connaît les
// terminaux) ; null = interrupteur inactif -> `fees` à 0 et profit BRUT, comme avant.
// Une route non bornée n'a pas de volume : aucun frais n'y est calculable (son profit est déjà
// null), et son score reste donc assis sur la marge brute par SCU.
export function routeMetrics(m, f, autoload = null) {
  const units = computeUnits(m.buyPrice, m.buyStock, m.sellDemand, f, m.demandKnown);
  const bounded = isFinite(units);
  const fees = bounded ? haulFee(units, autoload) : 0;
  const profit = bounded ? units * m.margin - fees : null;
  const minutes = tripMinutes(m.distance, !m.sameSystem);
  const profitHour = profitPerHour(profit, minutes);
  const rawScore = rawScoreOf(profitHour, m.margin, pairAge(m.buyUpdated, m.sellUpdated), m.buyStock, m.sellDemand);
  return {
    units: bounded ? units : null,
    investment: bounded ? units * m.buyPrice : null,
    profit, minutes, profitHour, rawScore, fees,
  };
}

// Idem pour une boucle A⇄B (deux segments). out/back = { buyPrice, stock, demand, margin,
// updated, demandKnown }. La boucle n'est bornée que si SES DEUX segments le sont.
// `autoload` = { a, b } : les points de frais des deux EXTRÉMITÉS (une boucle n'a pas un terminal
// d'achat et un de vente, elle a deux stations qui sont tour à tour l'un et l'autre). D'où QUATRE
// opérations facturées : charge en A + décharge en B pour l'aller, charge en B + décharge en A
// pour le retour. Les paires sont inversées entre les deux jambes parce que les caisses de chaque
// jambe sont faites à SON terminal de départ (hypothèse 1).
export function loopMetrics(out, back, distance, cross, f, autoload = null) {
  const loopMargin = out.margin + back.margin;
  const uOut = computeUnits(out.buyPrice, out.stock, out.demand, f, out.demandKnown);
  const uBack = computeUnits(back.buyPrice, back.stock, back.demand, f, back.demandKnown);
  const bounded = isFinite(uOut) && isFinite(uBack);
  const minutes = loopMinutes(distance, cross);
  const fees = bounded && autoload
    ? haulFee(uOut, { buy: autoload.a, sell: autoload.b }) + haulFee(uBack, { buy: autoload.b, sell: autoload.a })
    : 0;
  const profit = bounded ? uOut * out.margin + uBack * back.margin - fees : null;
  const profitHour = profitPerHour(profit, minutes);
  const rawScore = rawScoreOf(
    profitHour, loopMargin, pairAge(out.updated, back.updated),
    Math.min(out.stock, back.stock), tighterVolume(out.demand, back.demand)
  );
  return {
    loopMargin,
    unitsOut: bounded ? uOut : null,
    unitsBack: bounded ? uBack : null,
    units: bounded ? uOut + uBack : null,
    investment: bounded ? Math.max(uOut * out.buyPrice, uBack * back.buyPrice) : null,
    profit, minutes, profitHour, rawScore, fees,
  };
}

// ---------- Marge et ROI nets des frais d'autoload (vue « Trajets », mode à une commodité) ----------
// La marge de marché (vente − achat) ne dit pas ce que le joueur encaisse par SCU dès que la
// manutention se paie. On répartit donc les frais sur le volume réellement transporté.
// Deux cas où il n'y a RIEN à répartir et où les valeurs de marché sont rendues telles quelles :
// aucun frais (interrupteur éteint, ou terminal sans autoload), et volume inconnu — une route non
// bornée (soute et budget coupés) n'a pas de SCU sur quoi étaler un coût fixe.
// Le ROI se déduit de la marge nette : (marge × units − frais) / (achat × units) = marge_nette / achat.
export function netMarginRoi(margin, buyPrice, units, fees) {
  const net = fees > 0 && units > 0 ? margin - fees / units : margin;
  return { margin: net, roi: buyPrice > 0 ? Math.round((net / buyPrice) * 1000) / 10 : 0 };
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
// `items` déjà triés par ordre de priorité — par marge décroissante quand la soute est la seule
// contrainte, par rendement du capital quand le budget borne (`manifestsFrom` essaie les deux et
// garde le meilleur). Plafonné par stock/demande ET budget.
export function fillCargo(items, cargo, budget) {
  let cargoLeft = cargo;
  let budgetLeft = budget;
  const lines = [];
  let profit = 0;
  for (const it of items) {
    if (cargoLeft <= 0 || budgetLeft <= 0) break;
    let u = cargoLeft;
    u = Math.min(u, it.stock);                          // stock 0 = vide -> ligne exclue (u <= 0)
    if (it.demand != null || it.demandKnown) u = Math.min(u, it.demand); // null = inconnu ; 0 = saturé
    if (isFinite(budgetLeft)) u = Math.min(u, Math.floor(budgetLeft / it.buyPrice));
    if (u <= 0) continue;
    lines.push({ ...it, units: u, cap: u });
    cargoLeft -= u;
    budgetLeft -= u * it.buyPrice;
    profit += u * it.margin;
  }
  return { lines, profit };
}

// ---------- Manifeste : totaux, unités d'ajout libre, assemblage d'une ligne ----------
// Totaux d'un manifeste (liste de lignes { units, buyPrice, margin }). Source unique de vérité
// pour profit/investissement/SCU — utilisée par toutes les vues (En route + jambes de voyage).
// `autoload` = { buy, sell } (points de frais des deux terminaux du chargement) ; null = aucun
// frais, `profit` reste le total brut. HYPOTHÈSE 2 de la spec : une transaction PAR COMMODITÉ,
// donc autant de fois la base de 150 qu'il y a de lignes — c'est le choix pessimiste, faute de
// mesure. `profit` est NET des frais ; `fees` les expose à part pour l'infobulle et le détail.
// Chaque ligne paie les opérations qu'elle subit RÉELLEMENT (cf. lineHaulFee) : une ligne chargée
// ici pour être vendue ailleurs n'est pas déchargée à l'arrivée, une ligne déjà en soute n'a pas
// été chargée au départ.
// L'investissement, lui, reste le capital immobilisé à l'achat : les frais sont une charge
// d'exploitation, pas de la marchandise.
export function manifestTotals(lines, autoload = null) {
  let profit = 0, invest = 0, scu = 0, fees = 0;
  for (const l of lines) {
    const u = l.units || 0;
    profit += u * (l.margin || 0);
    invest += u * (l.buyPrice || 0);
    scu += u;
    fees += lineHaulFee(u, l, autoload);
  }
  return { profit: profit - fees, invest, scu, fees };
}

// Unités pour un ajout LIBRE au manifeste (commodité choisie à la main, éventuellement carry-only) :
// remplit l'espace restant, plafonné par le stock connu, mais AU MOINS 1 SCU (ajout volontaire).
// Comportement partagé En route / jambe de voyage. Deux cas ne remplissent PAS la soute :
//   - cargoLeft non fini (soute désactivée) : on ne sait pas ce qu'on peut emporter ;
//   - stock non fini : rien à acheter sur place (butin trouvé ailleurs) — proposer une soute pleine
//     d'un fret introuvable au terminal de départ chiffrerait un profit qui n'existe pas.
// Dans les deux cas -> 1 SCU, et l'utilisateur ajuste la quantité à ce qu'il a réellement.
export function freeAddUnits(stock, cargoLeft) {
  if (!Number.isFinite(stock)) return 1;
  const u = Number.isFinite(cargoLeft) ? Math.max(0, cargoLeft) : 0;
  return Math.max(1, Math.min(u, stock));
}

// Assemble une ligne de manifeste depuis une commodité `c` et ses valeurs résolues (corrections
// comprises). `buy`/`sell` = { price, vol, ovol } résolus, ou null si le point n'existe pas de ce
// côté. Les deux côtés manquants sont balisés SYMÉTRIQUEMENT, sans quoi le rendu affiche un prix
// d'achat « 0 » indiscernable d'un vrai relevé UEX :
//   - sans vente (`sell` null) -> `carry` : chargée ici pour être écoulée ailleurs ;
//   - sans achat (`buy` null)  -> `acquired` : déjà en soute (butin, minage, salvage), coût nul.
// `paid` (optionnel) = prix RÉELLEMENT payé au SCU pour une cargaison déjà à bord. Sans lui, une
// commodité qu'aucun terminal de départ ne vend est classée `acquired` — butin, coût nul — et son
// profit compte la revente ENTIÈRE comme gain. C'est juste pour du minage ou du salvage, et faux
// de 250 % pour du fret acheté ailleurs qu'on transporte encore (cf. ADR-002).
export function manifestLine(c, buy, sell, buyUpdated, sellUpdated, units, cap, paid = null) {
  const porte = paid != null && paid >= 0;          // fret embarqué dont on connaît le coût
  const buyPrice = porte ? paid : buy ? buy.price : 0;
  return {
    name: c.name, kind: c.kind, illegal: c.illegal,
    buyPrice, stock: buy ? buy.vol : Infinity,
    sellPrice: sell ? sell.price : null,
    demand: sell ? sell.vol : null,
    demandKnown: sell ? sell.ovol : false,
    margin: sell ? sell.price - buyPrice : 0,
    buyUpdated: buyUpdated || 0, sellUpdated: sellUpdated || 0,
    units, cap, carry: !sell,
    // `acquired` dit « rien n'a été chargé ici » : vrai pour du butin comme pour du fret embarqué
    // ailleurs — dans les deux cas l'autoload du terminal de départ ne l'a pas manipulé. Ce qui
    // les sépare, c'est le COÛT, et c'est `paid` qui le porte.
    acquired: !buy || porte,
    aBord: porte,
  };
}

// Résout les deux côtés d'une commodité entre deux terminaux (corrections locales comprises).
// `null` d'un côté = ce terminal ne traite pas cette commodité — cas NORMAL, pas une erreur :
// on charge un fret pour l'écouler ailleurs, ou on transporte un butin acquis ailleurs.
function resolveSides(market, fromIdx, toIdx, c, resolve) {
  const ft = market.terminals[fromIdx], tt = market.terminals[toIdx];
  const b = c.buys.find((x) => x[0] === fromIdx);
  const s = c.sells.find((x) => x[0] === toIdx);
  return {
    b, s,
    eb: b ? resolve(c.name, ft.name, "buy", b[1], b[2], b[3]) : null,
    es: s ? resolve(c.name, tt.name, "sell", s[1], s[2], s[3]) : null,
  };
}

// Ligne de manifeste pour un ajout LIBRE : l'utilisateur choisit la commodité, les unités
// remplissent l'espace restant. Partagée par « En route » et par les jambes de voyage, qui en
// tenaient deux copies divergentes — l'une testait le doublon avant de muter l'état, l'autre après.
export function freeManifestLine(market, fromIdx, toIdx, c, cargoLeft, resolve) {
  const { b, s, eb, es } = resolveSides(market, fromIdx, toIdx, c, resolve);
  const u = freeAddUnits(eb ? eb.vol : Infinity, cargoLeft);
  return manifestLine(c, eb, es, b ? b[3] : 0, s ? s[3] : 0, u, u);
}

// Ligne RÉ-HYDRATÉE depuis la seule intention persistée { name, units }.
// On ne persiste JAMAIS d'instantané de marché : figé, il continuerait d'afficher le prix du jour
// de l'édition longtemps après qu'UEX l'ait republié, avec une pastille de fraîcheur qui vieillit
// sans jamais refléter le vrai relevé. Prix, stock, demande et dates sont donc relus à chaque rendu.
export function hydrateManifestLine(market, fromIdx, toIdx, c, units, resolve) {
  const { b, s, eb, es } = resolveSides(market, fromIdx, toIdx, c, resolve);
  const cap = tighterVolume(eb ? eb.vol : Infinity, es ? es.vol : null);
  return manifestLine(c, eb, es, b ? b[3] : 0, s ? s[3] : 0, units, cap);
}

// ---------- Décomposition en caisses SCU standard ----------
// Répartit N SCU en conteneurs standard (plus grand d'abord). Renvoie [{size, count}, ...].
// `maxBox` (optionnel) plafonne la taille de caisse : un terminal dont max_container_size vaut 16
// ne peut pas sortir une caisse de 32, et le nombre de caisses est ce qui décide des frais
// d'autoload. Absent ou inexploitable (sous la plus petite caisse), on garde la grille complète :
// mieux vaut une décomposition optimiste qu'un volume qui s'évapore faute de caisse capable.
export const SCU_BOX_SIZES = [32, 24, 16, 8, 4, 2, 1];
export function scuBoxes(n, maxBox) {
  n = Math.max(0, Math.floor(n || 0));
  const sizes = maxBox >= 1 ? SCU_BOX_SIZES.filter((s) => s <= maxBox) : SCU_BOX_SIZES;
  const out = [];
  for (const size of sizes) {
    const count = Math.floor(n / size);
    if (count > 0) { out.push({ size, count }); n -= count * size; }
  }
  return out;
}

// Caisses d'un chargement à PLUSIEURS commodités. Une caisse n'en contient qu'une seule : le
// décompte se fait donc ligne par ligne, jamais sur le total des SCU. Décomposer le total
// inventerait des caisses pleines qui n'existent pas (quatre commodités de 8 SCU font quatre
// caisses de 8, pas une de 32) — et ce décompte sert à EXPLIQUER un montant que manifestTotals
// facture, lui, une ligne à la fois. Un « 📦 1×32 » à côté d'un montant calculé sur quatre caisses
// serait l'incohérence la plus visible qui soit.
export function cargoBoxes(lines, maxBox) {
  const parTaille = new Map();
  for (const l of lines) {
    for (const b of scuBoxes(l.units, maxBox)) parTaille.set(b.size, (parTaille.get(b.size) || 0) + b.count);
  }
  return [...parTaille].sort((a, b) => b[0] - a[0]).map(([size, count]) => ({ size, count }));
}

// ---------- Frais d'autoload ----------
// Charger et décharger la soute automatiquement se paie, et la facture ne dépend NI du prix NI de
// la commodité : c'est de la manutention, pas une commission. Ces trois nombres ne sont pas
// choisis, ils se DÉDUISENT de 18 relevés en jeu (4.9) sur deux stations Pyro — le détail des
// mesures est dans docs/superpowers/specs/2026-08-10-frais-autoload-design.md :
//   base   150 : constante retrouvée à l'aUEC près sur les quatre séries d'Endgame
//                (340−190 = 510−360 = 645−494,7 = 830−680) ;
//   perBox  30 : à Ruin, 32 SCU en deux caisses de 16 coûtent exactement 56 de plus qu'en une
//                caisse de 32, soit 30 une fois le coefficient de station retiré ;
//   perScu  20 : la pente de la grille, identique aux deux stations à trois décimales près — ce
//                qui est précisément ce qui autorise à réduire la station à un simple facteur.
// `k` est ce facteur : 1 = tarif Endgame (l'ancrage), 1,4 = Ruin Station. Le modèle colle aux
// 18 relevés à 2,8 % près : c'est une ESTIMATION, tout montant affiché doit porter un « ≈ ».
export const AUTOLOAD = { base: 150, perBox: 30, perScu: 20 };

// Frais d'UNE opération (un chargement ou un déchargement) de `scu` SCU dans un terminal plafonné
// à `maxBox` SCU par caisse, au coefficient de station `k`. Renvoie un entier d'aUEC.
export function autoloadFee(scu, maxBox, k) {
  const units = Math.max(0, Math.floor(scu || 0));
  // Rien à manutentionner, ou station qui ne facture pas (k = 0) : aucun frais. La base de 150
  // paie une transaction, pas une visite — la faire payer à vide grèverait un trajet qu'on
  // n'effectue pas, et surtout les routes non bornées, où computeUnits ne rend aucun volume.
  if (!isFinite(units) || units <= 0 || !(k > 0)) return 0;
  const boxes = scuBoxes(units, maxBox).reduce((a, b) => a + b.count, 0);
  return Math.round(k * (AUTOLOAD.base + AUTOLOAD.perBox * boxes + AUTOLOAD.perScu * units));
}

// ---------- Contexte de frais : un point par terminal, une paire par chargement ----------
// Tout le moteur reçoit ce contexte en PARAMÈTRE OPTIONNEL, et son absence (null) est le chemin
// par défaut : sans lui, chaque fonction rend exactement les valeurs brutes qu'elle rendait avant
// que les frais n'existent. L'interrupteur de l'interface est donc littéralement « passer null ».
//
// Un « point de frais » décrit ce qu'UN terminal facture : { maxBox, k }. Un terminal qui ne
// propose pas l'autoload prend k = 0 — il ne facture rien — mais GARDE son maxBox : c'est encore
// lui qui décide de la taille des caisses, même quand c'est le joueur qui les empile à la main.
// Les deux champs peuvent manquer du terminal (instantané de market.json antérieur au build qui
// les ajoute, ou coquille servie depuis le cache du service worker) : lecture défensive.
export function autoloadPoint(terminal, k) {
  if (!terminal) return null;
  return { maxBox: terminal.maxBox, k: terminal.autoload === true ? k : 0 };
}

// Frais des DEUX opérations d'un chargement de `scu` SCU : chargement au terminal d'achat,
// déchargement au terminal de vente, chacun au tarif de SA station.
// `pair` = { buy, sell } (points de frais) ; null/absent -> aucun frais.
// HYPOTHÈSE 1 de la spec : le nombre de caisses est fixé au CHARGEMENT. On décharge les caisses
// qu'on a — seul le tarif change — d'où le maxBox du terminal d'ACHAT des deux côtés. Le passer
// en paramètre plutôt que de le laisser au site d'appel évite l'erreur symétrique (re-caisser la
// cargaison en vol au plafond du terminal d'arrivée), qu'aucune signature ne saurait interdire.
export function haulFee(scu, pair) {
  if (!pair) return 0;
  const { buy, sell } = pair;
  const maxBox = buy ? buy.maxBox : sell && sell.maxBox; // sans achat connu, le seul plafond connu
  return (buy ? autoloadFee(scu, maxBox, buy.k) : 0) + (sell ? autoloadFee(scu, maxBox, sell.k) : 0);
}

// Frais d'UNE LIGNE de manifeste, qui ne subit pas toujours les DEUX opérations — et c'est
// manifestLine qui le dit, en balisant les deux côtés manquants :
//   - `carry` (« vend ailleurs ») : chargée ici, elle reste en soute à l'arrivée. Rien n'est
//     déchargé, et sa colonne profit affiche « — » : lui facturer un déchargement retranchait du
//     total un montant qu'aucune ligne à l'écran ne montrait.
//   - `acquired` (« acquis ailleurs » : butin, minage, salvage) : déjà à bord au départ. L'autoload
//     du terminal d'achat ne l'a jamais chargée.
// L'extrémité qui ne manutentionne rien passe à k = 0 au lieu d'être retirée de la paire : elle
// garde ainsi son `maxBox`, donc le décompte de caisses reste celui du terminal de chargement
// (hypothèse 1) — c'est-à-dire exactement celui que le « 📦 » de la ligne affiche.
export function lineHaulFee(units, line, pair) {
  if (!pair) return 0;
  const { carry, acquired } = line || {};
  if (!carry && !acquired) return haulFee(units, pair);
  const muet = (p) => (p ? { maxBox: p.maxBox, k: 0 } : p);
  return haulFee(units, {
    buy: acquired ? muet(pair.buy) : pair.buy,
    sell: carry ? muet(pair.sell) : pair.sell,
  });
}

// ---------- Chaîne multi-sauts (A -> B -> C ...) ----------
// Meilleure chaîne de `hops` sauts depuis `start`, sans revisiter un terminal.
// adj : Map<terminal, leg[]> ; leg = { to, margin, stock, demand, buyPrice, fee?, ... }.
// Recherche par faisceau (beam) : approximation robuste et bornée en temps. Chaque saut
// remplit la soute (`cargo`), plafonnée par stock/demande ; le budget se reconstitue à la
// vente donc n'est pas une contrainte de chaîne. Renvoie { path, legs, profit } ou null.
// Les frais d'autoload arrivent ici PAR LE LEG (`leg.fee` = { buy, sell }, posé par
// buildChainAdjacency) : bestChain ne voit ni terminaux ni filtres, et c'est le seul canal
// disponible. Sans ce champ — donc par défaut — les profits sont strictement ceux d'avant.
// Volume réellement emportable sur un saut, et ce qu'il RAPPORTE une fois ses deux opérations
// payées. Exporté parce que buildChainAdjacency doit classer les candidates d'une paire sur le
// profit que bestChain leur donnera vraiment : un autre plafond de volume et le classement
// porterait sur un saut qui n'existe pas.
export function chainLegNet(leg, cargo) {
  let u = cargo;
  u = Math.min(u, leg.stock);                     // stock 0 = terminal vide -> saut exclu
  if (leg.demand != null || leg.demandKnown) u = Math.min(u, leg.demand); // null = inconnu ; 0 = saturé
  const units = isFinite(u) ? Math.max(0, u) : 0; // sans borne de volume : rien (chaîne = soute finie)
  return { units, profit: units * leg.margin - haulFee(units, leg.fee) };
}

// Le faisceau tronque à chaque saut sur le profit CUMULÉ : un premier saut modeste qui ouvre sur un
// circuit énorme est décapité avant d'avoir pu le montrer. Mesuré sur data/market.json (96 SCU,
// 3 sauts) : à 40, 39 origines sur 107 rendaient plus de 5 % sous l'optimum du graphe, jusqu'à ×4,53
// (Sunset Mesa, 582 816 -> 2 637 576). À 400, plus aucune. Le coût est payé une fois par action
// utilisateur — l'app ne calcule qu'UNE chaîne — soit 7 ms sur le pire cas de l'UI (4 sauts) contre
// 0,8 ms : imperceptible, là où la sous-optimalité, elle, se voyait.
export function bestChain(adj, start, hops, { cargo = Infinity, beam = 400 } = {}) {
  let paths = [{ path: [start], visited: new Set([start]), profit: 0, legs: [] }];
  let best = null;
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const p of paths) {
      const u = p.path[p.path.length - 1];
      for (const leg of adj.get(u) || []) {
        if (leg.margin <= 0 || p.visited.has(leg.to)) continue;
        // Deux opérations par saut (chargement au départ, déchargement à l'arrivée). Un saut dont
        // les frais mangent la marge fait PERDRE de l'argent : on l'écarte, exactement comme un
        // saut de marge nulle plus haut — sans quoi l'invariant « chaque saut ajoute un profit
        // positif » tomberait et la meilleure chaîne pourrait être plus courte que la retenue.
        const { units, profit: legProfit } = chainLegNet(leg, cargo);
        if (units <= 0 || legProfit <= 0) continue;
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
  if (it.demand != null || it.demandKnown) u = Math.min(u, it.demand); // null = inconnu ; 0 = saturé
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
// `market` = { terminals:[{name,system,planet,outpost,autoload,maxBox}],
//              commodities:[{name,kind,illegal,buys,sells}] }
// où chaque buy/sell est un tuple compact [idxTerminal, prix, volume, updated, statut].
// `autoload`/`maxBox` peuvent manquer d'un instantané antérieur : toute lecture est défensive.
// `resolve(commodity, terminalName, side, price, vol, updated)` applique les corrections locales et
// renvoie au moins { price, vol, ovol } (identité si aucune correction). PURES si `resolve` l'est.
// `autoloadFor(terminal)` -> point de frais { maxBox, k } de ce terminal (voir autoloadPoint).
// null = interrupteur inactif, et c'est le défaut : aucun frais n'est alors calculé nulle part.

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
// `f` + `autoloadFor` (optionnels) font retenir la destination sur le profit NET au lieu du prix
// affiché. C'était le dernier point d'entrée aveugle aux frais : deux stations qui paient presque
// pareil ne facturent pas pareil la manutention, et comme cette fonction ne garde qu'UNE vente par
// commodité, la meilleure en net n'entrait jamais dans la liste — le tableau montrait alors une
// destination pendant que la carte Manifeste, sur le MÊME écran, en affichait une autre.
// Sans eux — donc par défaut — le critère reste le prix de vente le plus élevé, à l'identique.
export function enRouteDeals(market, origin, destSystem, destTerminal = null, f = null, autoloadFor = null) {
  const deals = [];
  const buyPoint = autoloadFor ? autoloadFor(market.terminals[origin]) : null;
  market.commodities.forEach((c) => {
    const b = c.buys.find((x) => x[0] === origin);
    if (!b) return;
    // Profit RÉALISABLE d'une vente candidate, dans les termes exacts de routeMetrics. Le prix au SCU
    // ne suffit pas : `computeUnits` plafonne ensuite par la demande du terminal, si bien qu'une
    // vente très chère mais presque saturée rapporte moins qu'une vente un peu moins chère qui prend
    // toute la soute — et la bonne destination, écartée ici, n'apparaît alors nulle part.
    // Sans `f` (aucune contrainte connue) ou sur un volume non borné, il n'y a rien à comparer que
    // le prix : c'est aussi le cas où toutes les destinations chargent autant, donc où le prix le
    // plus haut EST l'optimum. `routeMetrics` laisse déjà ces routes au brut.
    const score = (s) => {
      if (!f) return s[1];
      const u = computeUnits(b[1], b[2], s[2], f);
      if (!isFinite(u)) return s[1];
      const fee = autoloadFor ? haulFee(u, { buy: buyPoint, sell: autoloadFor(market.terminals[s[0]]) }) : 0;
      return u * (s[1] - b[1]) - fee;
    };
    let best = null, bestScore = 0;
    for (const s of c.sells) {
      if (s[0] === origin) continue;
      if (destTerminal != null) { if (s[0] !== destTerminal) continue; }
      else if (destSystem && market.terminals[s[0]].system !== destSystem) continue;
      // Une vente qui ne bat pas le prix d'achat n'a jamais été un candidat : ce filtre était en
      // sortie de boucle (`best[1] > b[1]`), le remonter ici ne change rien au critère brut et
      // empêche une vente à volume nul — donc à frais nuls, donc au « meilleur » net — de faire
      // disparaître du tableau une commodité qui, ailleurs, se vend avec profit.
      if (s[1] <= b[1]) continue;
      const sc = score(s);
      // Égalité -> le prix brut départage, comme avant (le critère brut ne change donc jamais d'avis).
      if (!best || sc > bestScore || (sc === bestScore && s[1] > best[1])) { best = s; bestScore = sc; }
    }
    if (best) deals.push(dealFrom(market, c, b, best));
  });
  return deals;
}

// Éligibilité d'un couple achat/vente, partagée par le manifeste OPTIMAL et par les SUGGESTIONS
// de remplissage. Les deux en tenaient chacune une copie, et elles avaient divergé : la boîte de
// suggestions ne filtrait que « légales », si bien qu'elle proposait — et permettait d'insérer —
// des commodités que le manifeste venait d'écarter pour relevé trop vieux ou avant-poste exclu.
export function pairEligible(f, c, sellTerminal, buyUpdated, sellUpdated) {
  if (f.legalOnly && c.illegal) return false;
  if (f.noOutpost && sellTerminal.outpost) return false;
  // Fraîcheur : ignore les relevés trop vieux (0 = filtre inactif -> comportement inchangé).
  if (f.maxAge) { const a = pairAge(buyUpdated, sellUpdated); if (a == null || a > f.maxAge) return false; }
  return true;
}

// Commodités qui pourraient remplir l'espace libre d'un manifeste (même origine -> même
// destination), hors celles déjà chargées, triées par marge décroissante.
// `m` = contexte de manifeste { lines, originIdx, destIdx, origin, dest, f }.
export function suggestionsFrom(market, m, resolve) {
  const have = new Set(m.lines.map((l) => l.name));
  const st = market.terminals[m.destIdx];
  const out = [];
  market.commodities.forEach((c) => {
    if (have.has(c.name)) return;
    const b = c.buys.find((x) => x[0] === m.originIdx);
    const s = c.sells.find((x) => x[0] === m.destIdx);
    if (!b || !s) return;
    if (!pairEligible(m.f, c, st, b[3], s[3])) return;
    const eb = resolve(c.name, m.origin.name, "buy", b[1], b[2], b[3]);
    const es = resolve(c.name, m.dest.name, "sell", s[1], s[2], s[3]);
    const margin = es.price - eb.price;
    if (margin <= 0) return;
    out.push({ name: c.name, kind: c.kind, illegal: c.illegal, buyPrice: eb.price, stock: eb.vol, sellPrice: es.price, demand: es.vol, demandKnown: es.ovol, margin, buyUpdated: b[3], sellUpdated: s[3] });
  });
  return out.sort((a, b) => b.margin - a.margin);
}

// TOUS les manifestes depuis `origin` : un par destination atteignable, soute remplie par marge
// décroissante (fillCargo). Trié par profit décroissant. `bestManifest` n'en garde que le premier ;
// la vue « Trajets » en mode multi-commodité les garde tous. Renvoie [] si la soute n'est pas bornée.
// Le tri se fait sur le profit NET dès que `autoloadFor` est fourni — c'est ici que la destination
// gagnante se décide, un net calculé après coup par l'appelant arriverait trop tard. Chaque trajet
// emporte le contexte de frais qui l'a produit (`fee`), pour que tripMetrics et les recalculs de
// manifeste d'app.js n'aient pas à le reconstruire — ni à risquer de le reconstruire autrement.
export function manifestsFrom(market, origin, destSystem, f, resolve, destTerminal = null, autoloadFor = null) {
  if (!f.useCargo || !(f.cargo > 0)) return [];
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
      if (!pairEligible(f, c, st, b[3], s[3])) return;
      const es = resolve(c.name, st.name, "sell", s[1], s[2], s[3]);
      const margin = es.price - eb.price;
      if (margin <= 0) return;
      if (!byDest.has(s[0])) byDest.set(s[0], []);
      byDest.get(s[0]).push({ name: c.name, kind: c.kind, illegal: c.illegal, buyPrice: eb.price, stock: eb.vol, sellPrice: es.price, demand: es.vol, demandKnown: es.ovol, margin, buyUpdated: b[3], sellUpdated: s[3] });
    });
  });

  const budget = f.useBudget && f.budget > 0 ? f.budget : Infinity;
  const buyPoint = autoloadFor ? autoloadFor(ot) : null;
  const trips = [];
  // Deux ordres de remplissage, parce qu'aucun n'est optimal seul. Par marge décroissante : optimal
  // quand la SOUTE est la seule contrainte. Par rendement du capital : préférable quand le BUDGET
  // borne, car une ligne chère draine sinon le budget et laisse la soute à moitié vide (50 000/SCU
  // épuise 100 000 aUEC en 2 SCU). Mais le rendement n'est pas non plus l'optimum — c'est un sac à
  // dos à deux contraintes — et il dégrade certains cas. On garde donc le meilleur des deux : jamais
  // pire qu'aujourd'hui par construction, et le second passage ne coûte que sous budget borné.
  const parMarge = (a, b) => b.margin - a.margin;
  const parRendement = (a, b) => (b.margin / b.buyPrice) - (a.margin / a.buyPrice) || parMarge(a, b);
  for (const [dest, items] of byDest) {
    const dt = market.terminals[dest];
    const fee = autoloadFor ? { buy: buyPoint, sell: autoloadFor(dt) } : null;
    // Un remplissage jusqu'à son profit FINAL. Comparer les deux ordres sur le brut choisirait sur
    // un chiffre qui n'est pas celui qui classe le manifeste : les frais grossissent avec le volume,
    // donc le remplissage le plus chargé n'est pas toujours le plus rentable une fois déduits.
    // Une ligne dont les frais dépassent la marge fait perdre de l'argent : la charger quand même
    // classerait ce manifeste sous un autre qui, lui, l'aurait laissée au sol. La place libérée ne
    // se recycle pas — les candidates suivantes sont moins rentables, par construction du tri.
    const evalue = (rempli) => {
      const kept = fee ? rempli.lines.filter((l) => l.units * l.margin > lineHaulFee(l.units, l, fee)) : rempli.lines;
      return { lines: kept, profit: fee ? manifestTotals(kept, fee).profit : rempli.profit };
    };
    let meilleur = evalue(fillCargo([...items].sort(parMarge), f.cargo, budget));
    if (isFinite(budget)) {
      const alt = evalue(fillCargo([...items].sort(parRendement), f.cargo, budget));
      if (alt.profit > meilleur.profit) meilleur = alt;
    }
    if (!meilleur.lines.length) continue;
    trips.push({ origin: ot, originIdx: origin, dest: dt, destIdx: dest, cross: ot.system !== dt.system, lines: meilleur.lines, profit: meilleur.profit, fee, cargo: f.cargo });
  }
  return trips.sort((a, b) => b.profit - a.profit);
}

// Manifeste : destination (terminal) qui maximise le profit d'un chargement multi-commodité depuis
// `origin`, soute remplie par marge décroissante (fillCargo). Toujours plafonné par stock/demande
// (ce qui force à diversifier). Null si la soute n'est pas contrainte.
// `destTerminal` (index) force un terminal d'arrivée précis ; sinon `destSystem` filtre par système.
export function bestManifest(market, origin, destSystem, f, resolve, destTerminal = null, autoloadFor = null) {
  return manifestsFrom(market, origin, destSystem, f, resolve, destTerminal, autoloadFor)[0] || null;
}

// ---------- Trajets MULTI-COMMODITÉ (vue « Trajets », coche « Multi commodité ») ----------
// Champs dérivés d'un trajet multi-commodité, à la forme attendue par bySort/normalizeScores et
// les colonnes du tableau. La marge est la marge MOYENNE pondérée par SCU (profit / SCU chargés).
// Distance exacte indisponible hors routes.json -> tripMinutes(0, cross), comme « En route ».
// Les frais viennent du trajet lui-même (`trip.fee`, posé par manifestsFrom) : tripMetrics est la
// seule fonction de métriques à ne recevoir ni `f` ni terminaux, et un trajet fabriqué à la main
// (donc sans `fee`) reste chiffré au brut.
// Marge et ROI sont NETS des frais, dans les deux modes de la vue « Trajets » : ce qui compte est
// ce que le joueur encaisse par SCU, pas l'écart de prix affiché aux terminaux. Ils suivent donc
// `profit` (déjà net) et non `brut`. `marginGross` conserve la marge de MARCHÉ pour `legFromTrip` :
// une jambe de voyage ne doit pas figer une marge nette dans le parcours, où elle se cumulerait
// avec les marges brutes des jambes venues des autres vues — et où elle survivrait à l'extinction
// de l'interrupteur, jusque dans le permalien `j=`.
export function tripMetrics(trip) {
  const { profit, invest, scu, fees } = manifestTotals(trip.lines, trip.fee);
  const minutes = tripMinutes(0, trip.cross);
  const profitHour = profitPerHour(profit, minutes);
  const brut = fees ? profit + fees : profit;
  const marginGross = scu > 0 ? brut / scu : 0;
  const margin = scu > 0 ? profit / scu : 0;
  const roi = invest > 0 ? Math.round((profit / invest) * 1000) / 10 : 0;
  // Fiabilité : le relevé le PLUS VIEUX du chargement et les volumes les plus contraints.
  let age = null, stock = Infinity, demand = Infinity;
  for (const l of trip.lines) {
    const a = pairAge(l.buyUpdated, l.sellUpdated);
    if (a != null && (age == null || a > age)) age = a;
    stock = Math.min(stock, l.stock == null ? Infinity : l.stock);
    demand = Math.min(demand, l.demand == null ? Infinity : l.demand);
  }
  // demand resté à Infinity = aucune ligne n'a de capacité connue -> null (inconnu), pas 0 (saturé).
  const rawScore = rawScoreOf(profitHour, margin, age, Number.isFinite(stock) ? stock : 0, Number.isFinite(demand) ? demand : null);
  // commodity/buyPrice/sellPrice : valeurs représentatives pour que le tri par colonne du tableau
  // « Trajets » reste utilisable en mode multi (ligne de tête = plus grosse marge, prix moyens/SCU).
  const buyPrice = scu > 0 ? invest / scu : 0;
  return {
    units: scu, investment: invest, profit, margin, marginGross, roi, minutes, profitHour, rawScore, fees,
    nLines: trip.lines.length, commodity: trip.lines[0] ? trip.lines[0].name : "",
    buyPrice, sellPrice: buyPrice + margin,
  };
}

// Jambe de voyage depuis un trajet multi-commodité (le manifeste de la jambe est recalculé par la
// vue Voyage, donc on ne retient que la commodité de tête comme libellé).
// La jambe retient la marge de MARCHÉ (`marginGross`), jamais la marge nette : elle est persistée
// et voyage dans le permalien `j=`, où des frais estimés au moment du clic n'auraient plus aucun
// sens — l'interrupteur peut être éteint depuis, ou le tarif de la station avoir changé.
export function legFromTrip(t) {
  const top = t.lines[0] || {};
  return {
    from: t.origin.name, fromSystem: t.origin.system, to: t.dest.name, toSystem: t.dest.system,
    commodity: top.name || "", buyPrice: top.buyPrice || 0, sellPrice: top.sellPrice || 0,
    margin: (t.marginGross != null ? t.marginGross : t.margin) || 0,
  };
}

// Jambe de voyage depuis un MANIFESTE (vue « En route »). Un trajet de manifestsFrom a exactement
// la forme d'un trajet multi-commodité — origin, dest, lines, fee, cargo — à une exception près :
// il ne porte pas de marge, celle-ci vit dans tripMetrics. On la calcule donc ici, et on prend
// `marginGross` : la jambe est persistée et voyage dans le permalien `j=`, où une marge NETTE des
// frais d'autoload n'aurait plus de sens (l'interrupteur peut être éteint depuis) et se cumulerait
// avec les marges brutes des jambes venues des autres vues. Sans ce calcul, legFromTrip retomberait
// sur `t.margin` absent -> une jambe à 0 figée dans le lien.
// Ne PAS dériver la marge de `man.profit` : il est déjà net des frais.
export function legFromManifest(man) {
  return legFromTrip({ ...man, marginGross: tripMetrics(man).marginGross });
}

// Balaye TOUT le marché : pour chaque terminal d'achat, tous les remplissages multi-commodité vers
// chaque destination atteignable. Filtres appliqués : sysFilter/noOutpost sur le terminal de départ,
// sameOnly sur le saut, q sur les commodités chargées (legalOnly/noOutpost-arrivée/maxAge le sont
// déjà par manifestsFrom).
// `minLines` = nombre minimum de commodités par chargement (2 par défaut) : un trajet dont le
// remplissage optimal tient en UNE commodité est déjà couvert par la vue « Trajets » normale, on
// ne garde donc ici que les chargements réellement combinés. minLines:1 rend tout.
// Trié par profit décroissant puis TRONQUÉ à `limit` (garde-fou de perf : un tri utilisateur
// ultérieur ne réordonne que ces `limit` meilleurs trajets par profit). Ce profit est le NET dès
// que `autoloadFor` est fourni : la troncature décide QUELS trajets existent, un trajet meilleur
// en net serait donc coupé par le garde-fou avant même d'atteindre le tableau.
export function multiTrips(market, f, resolve, limit = 300, minLines = 2, autoloadFor = null) {
  const origins = new Set();
  market.commodities.forEach((c) => c.buys.forEach((b) => origins.add(b[0])));
  const out = [];
  for (const origin of origins) {
    const ot = market.terminals[origin];
    if (f.sysFilter && ot.system !== f.sysFilter) continue; // filtre système = système d'ACHAT
    if (f.noOutpost && ot.outpost) continue;
    for (const trip of manifestsFrom(market, origin, "", f, resolve, null, autoloadFor)) {
      if (trip.lines.length < minLines) continue;
      if (f.sameOnly && trip.cross) continue;
      if (f.q && !trip.lines.some((l) => l.name.toLowerCase().includes(f.q))) continue;
      out.push(trip);
    }
  }
  return out.sort((a, b) => b.profit - a.profit).slice(0, limit);
}

// Graphe des meilleurs segments : pour chaque paire (départ -> arrivée), la meilleure commodité
// (corrections comprises). Renvoie Map<idxTerminal, leg[]> pour bestChain.
// C'est le SEUL endroit de la chaîne où les deux terminaux d'un saut coexistent : le contexte de
// frais y est donc estampillé sur le leg (`fee`), que bestChain consomme sans jamais voir un
// terminal.
// Le critère de « meilleure » dépend des frais, et c'est indispensable : les frais ne dépendent que
// du VOLUME, or les volumes ne sont PAS égaux d'une commodité à l'autre (stock et demande diffèrent).
// La plus forte marge peut n'avoir que 2 SCU disponibles et se faire manger par la base de 150 —
// bestChain élague alors le saut ENTIER, et la vue Chaîne annonce « aucune chaîne rentable » alors
// que la commodité voisine, elle, remplissait la soute et rapportait. On classe donc sur le profit
// net au volume emportable dès que les frais sont actifs, et sur la marge sinon : le critère
// historique est conservé au caractère près tant que l'interrupteur est inactif.
export function buildChainAdjacency(market, f, resolve, autoloadFor = null) {
  const best = new Map(); // Map<u, Map<v, leg>>
  const cargo = f.useCargo && f.cargo > 0 ? f.cargo : Infinity;
  // Un seul segment survit par paire de terminaux : le retenir sur la marge nue évince pour de bon
  // une commodité un peu moins margée mais disponible en volume, et bestChain ne peut plus la
  // retrouver. On arbitre donc sur le gain RÉALISABLE, plafonné par stock et demande.
  // Sans soute bornée aucun volume n'est calculable (chainLegNet rend 0 pour tout le monde) : le
  // net ne discriminerait plus rien, on s'en tient alors à la marge.
  const parLeNet = isFinite(cargo);
  const mieux = (cand, cur) =>
    parLeNet ? chainLegNet(cand, cargo).profit > chainLegNet(cur, cargo).profit : cand.margin > cur.margin;
  market.commodities.forEach((c) => {
    if (f.legalOnly && c.illegal) return;
    // `resolve` ne dépend que de (c, s), jamais du point d'achat : sans mémo le même point de vente
    // est re-résolu une fois par achat (facteur ~4 sur les données réelles), chaque appel allouant
    // une clé et un objet pour rien. Le mémo est LOCAL (remis à zéro à chaque commodité) : un cache
    // global survivrait à une correction saisie par l'utilisateur et resservirait une valeur périmée.
    // Il est peuplé APRÈS les gardes, jamais avant : pré-résoudre toutes les ventes ferait payer
    // celles que `s[0]===b[0]`, `noOutpost`, `sameOnly` et surtout `maxAge` écartent — avec un filtre
    // de fraîcheur serré on résoudrait plus de points qu'aujourd'hui, et le correctif coûterait.
    const ventesRes = new Map(); // tuple de vente -> valeur effective (corrections comprises)
    c.buys.forEach((b) => {
      const bt = market.terminals[b[0]];
      if (f.noOutpost && bt.outpost) return;
      const eb = resolve(c.name, bt.name, "buy", b[1], b[2], b[3]);
      const bp = autoloadFor ? autoloadFor(bt) : null;
      c.sells.forEach((s) => {
        if (s[0] === b[0]) return;
        const st = market.terminals[s[0]];
        if (f.noOutpost && st.outpost) return;
        if (f.sameOnly && bt.system !== st.system) return;          // même système uniquement
        if (f.maxAge) { const a = pairAge(b[3], s[3]); if (a == null || a > f.maxAge) return; } // fraîcheur
        let es = ventesRes.get(s);
        if (es === undefined) { es = resolve(c.name, st.name, "sell", s[1], s[2], s[3]); ventesRes.set(s, es); }
        const margin = es.price - eb.price;
        if (margin <= 0) return;
        let m = best.get(b[0]);
        if (!m) { m = new Map(); best.set(b[0], m); }
        const cur = m.get(s[0]);
        const cand = { to: s[0], commodity: c.name, kind: c.kind, illegal: c.illegal, margin, buyPrice: eb.price, sellPrice: es.price, stock: eb.vol, demand: es.vol, demandKnown: es.ovol, fee: autoloadFor ? { buy: bp, sell: autoloadFor(st) } : null };
        if (!cur || mieux(cand, cur)) m.set(s[0], cand);
      });
    });
  });
  const adj = new Map();
  for (const [u, m] of best) adj.set(u, [...m.values()]);
  return adj;
}

// ---------- Panneau « Commodités » : résumé global + points d'achat/vente ----------
// Une ligne de synthèse par commodité (pour le grand tableau triable).
// f (optionnel) = { legalOnly, noOutpost, board } :
//   - legalOnly / noOutpost : masque les commodités illégales, exclut les points en avant-poste
//     du calcul best/compteurs ;
//   - board = "market" (défaut) -> uniquement les commodités ÉCHANGEABLES (achat ET vente) ;
//     board = "loot" -> mode Butin : tout ce qui se VEND, y compris ce qu'on ne peut acheter
//     nulle part (minerais raffinés, salvage, drogues de wreck) — le cas « je l'ai trouvé ».
// `resolve` applique les corrections locales, comme dans toutes les autres vues. Sans lui, le board
// classait et coloriait sur les prix BRUTS d'UEX : on corrigeait un prix dans un tableau, et la
// tuile de la commodité — sa marge, sa couleur, son rang — continuait d'afficher l'ancien chiffre.
// Optionnel pour rester pur par défaut (les tests l'appellent sans).
export function commoditySummaries(market, f = {}, resolve = null) {
  const loot = f.board === "loot";
  const out = [];
  const prix = (c, p, side) => (resolve ? resolve(c.name, market.terminals[p[0]].name, side, p[1], p[2], p[3]).price : p[1]);
  for (const c of market.commodities) {
    if (f.legalOnly && c.illegal) continue;
    // « Échangeable » se juge sur les données BRUTES : le juger après `noOutpost` ferait
    // disparaître du board Marché une commodité achetable seulement en avant-poste.
    const sellOnly = c.buys.length === 0;
    if (!loot && sellOnly) continue;
    const buys = f.noOutpost ? c.buys.filter((b) => !market.terminals[b[0]].outpost) : c.buys;
    const sells = f.noOutpost ? c.sells.filter((s) => !market.terminals[s[0]].outpost) : c.sells;
    // Achat le moins cher / vente la plus chère + le statut d'inventaire à ce point.
    let bestBuy = null, buyStatus = 0;
    for (const b of buys) { const v = prix(c, b, "buy"); if (bestBuy == null || v < bestBuy) { bestBuy = v; buyStatus = b[4] || 0; } }
    let bestSell = null, sellStatus = 0;
    for (const s of sells) { const v = prix(c, s, "sell"); if (bestSell == null || v > bestSell) { bestSell = v; sellStatus = s[4] || 0; } }
    // En mode Butin, une commodité sans point de vente restant n'a plus de réponse à offrir.
    if (loot && bestSell == null) continue;
    const margin = bestBuy != null && bestSell != null ? bestSell - bestBuy : null;
    out.push({
      name: c.name, code: c.code || "", kind: c.kind, illegal: c.illegal,
      nBuy: buys.length, nSell: sells.length, bestBuy, bestSell, buyStatus, sellStatus, margin,
      sellOnly,
    });
  }
  return out;
}

// Tous les points d'ACHAT (les moins chers d'abord) et de VENTE (les plus chers d'abord)
// d'une commodité, avec la localisation du terminal. Null si commodité inconnue.
// `resolve` : mêmes corrections locales que partout ailleurs (cf. commoditySummaries). Le tri
// « moins cher d'abord » / « mieux payé d'abord » porte donc sur les valeurs CORRIGÉES — sinon la
// liste se serait ordonnée sur des prix que l'utilisateur venait justement de démentir.
export function commodityPoints(market, name, f = {}, resolve = null) {
  const c = market.commodities.find((x) => x.name === name);
  if (!c) return null;
  const T = (i) => market.terminals[i];
  const keep = (p) => !(f.noOutpost && T(p[0]).outpost); // exclut les avant-postes si demandé
  const point = (p, volKey, side) => {
    const t = T(p[0]);
    const e = resolve ? resolve(c.name, t.name, side, p[1], p[2], p[3]) : null;
    return {
      terminal: t.name, system: t.system, planet: t.planet, outpost: t.outpost,
      price: e ? e.price : p[1], [volKey]: e ? e.vol : p[2], updated: p[3], status: p[4],
    };
  };
  const buys = c.buys.filter(keep).map((b) => point(b, "stock", "buy")).sort((a, b) => a.price - b.price);
  const sells = c.sells.filter(keep).map((s) => point(s, "demand", "sell")).sort((a, b) => b.price - a.price);
  return { name: c.name, code: c.code || "", kind: c.kind, illegal: c.illegal, buys, sells };
}

// Paliers de heatmap par RANG, pour le mode « Butin ».
// Les prix de revente s'étalent sur cinq ordres de grandeur (Saldynium à 34 M aUEC/SCU contre
// Iron Ore à 1 000) : une échelle relative au maximum, comme `marginTier`, tasserait tout le
// board dans le palier le plus bas sauf deux tuiles. Le rang, lui, colore toujours.
// Le classement se fait sur la VALEUR, jamais sur l'ordre d'affichage : trier par code A→Z ne
// doit pas recolorer le board. Les ex æquo partagent donc le rang du premier d'entre eux
// (classement « olympique ») : à prix égal, même palier, quel que soit l'ordre reçu.
export function valueTiers(rows, key = "bestSell") {
  const tiers = new Map();
  const ranked = [];
  for (const r of rows) {
    if (r[key] == null) tiers.set(r.name, "t-none"); // rien à classer -> hors barème
    else ranked.push(r);
  }
  ranked.sort((a, b) => b[key] - a[key]);
  const n = ranked.length;
  let rang = 0; // indice du premier ex æquo de la valeur courante
  ranked.forEach((r, i) => {
    if (i > 0 && r[key] !== ranked[i - 1][key]) rang = i;
    const q = rang / n; // part des commodités strictement mieux payées
    tiers.set(r.name, q < 0.15 ? "t-hot" : q < 0.40 ? "t-warm" : q < 0.70 ? "t-mid" : "t-low");
  });
  return tiers;
}

// Notation compacte K/M pour les tuiles du board (ex. 9600 -> "9.6K", 1_600_000 -> "1.6M").
export function compactValue(n) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return Math.round(n / 1e5) / 10 + "M";
  if (a >= 1e3) return Math.round(n / 100) / 10 + "K";
  return String(Math.round(n));
}

// ---------- Résolution d'une commodité (le code UEX n'est PAS une clé unique) ----------
// Piège : UEX attribue le même code à des commodités DISTINCTES — `COPP` désigne à la fois
// « Copper » (échangeable) et « Copper (Ore) » (butin, aucun point d'achat). Une recherche par
// `find()` sur nom-ou-code renvoyait donc toujours la première et rendait l'autre inatteignable.
// D'où : le nom exact prime, et un code ambigu ne résout RIEN plutôt que d'en désigner une au hasard.
export function resolveCommodity(commodities, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;
  const byName = commodities.find((c) => c.name.toLowerCase() === q);
  if (byName) return byName;
  const byCode = commodities.filter((c) => c.code && c.code.toLowerCase() === q);
  return byCode.length === 1 ? byCode[0] : null;
}

// Codes portés par PLUSIEURS commodités de la liste. Le board n'affiche le code seul que s'il
// identifie sa commodité : sinon deux tuiles seraient rigoureusement indiscernables à l'écran.
export function ambiguousCodes(rows) {
  const seen = new Set(), dup = new Set();
  for (const r of rows) {
    if (!r.code) continue;
    if (seen.has(r.code)) dup.add(r.code);
    else seen.add(r.code);
  }
  return dup;
}

// ---------- Libellé canonique d'une station « Nom — Système » ----------
// Clé unique des datalists et des maps terminal (originMap/stationMap) côté app. Un seul endroit
// définit le format -> pas de divergence entre les ~15 sites qui le construisaient à la main.
export const stationLabel = (name, system) => `${name} — ${system}`;
// Sépare un libellé en { name, system }. Coupe au PREMIER « — » (le nom prime), cohérent avec
// l'ancien `label.split(" — ")[0]`. Renvoie system:"" si le séparateur est absent.
export function parseStationLabel(label) {
  const s = String(label ?? "");
  const i = s.indexOf(" — ");
  return i < 0 ? { name: s, system: "" } : { name: s.slice(0, i), system: s.slice(i + 3) };
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
// Les filtres de la vue, appliqués à une destination candidate du VOYAGE. `sysFilter` borne le
// système d'ACHAT : dans un parcours l'origine est imposée par la jambe précédente, pas choisie
// dans le menu — le neutraliser ici, comme le fait « En route », est la seule différence.
const legPasses = (r, f) => routePasses(r, { ...f, sysFilter: "" });

// Destinations rentables depuis `origin` (index de terminal), pour proposer un arrêt de voyage :
// une entrée par terminal d'arrivée, celle de meilleure marge, les `limit` premières.
// Les filtres de la vue s'appliquent, exactement comme dans « En route ». Sans eux, la boîte
// proposait des trajets qu'AUCUNE vue n'accepte de montrer — commodité illégale alors que
// « légales uniquement » est coché, avant-poste exclu, relevé périmé — et la jambe ajoutée
// s'affichait « aucun fret rentable », son manifeste étant filtré, lui, par pairEligible.
// Même divergence de règles que celle qui a donné pairEligible : une seule source, partagée.
export function stopSuggestions(market, origin, f, limit = 4) {
  const byDest = new Map();
  for (const d of enRouteDeals(market, origin, "", null, f)) {
    if (!legPasses(d, f)) continue;
    const label = stationLabel(d.sell.terminal, d.sell.system);
    const cur = byDest.get(label);
    if (!cur || d.margin > cur.margin) {
      byDest.set(label, { label, terminal: d.sell.terminal, system: d.sell.system, commodity: d.commodity, margin: d.margin });
    }
  }
  return [...byDest.values()].sort((a, b) => b.margin - a.margin).slice(0, limit);
}
// Meilleure jambe entre deux terminaux (commodité de marge max), filtres appliqués comme
// ci-dessus, ou null si aucun fret éligible : l'appelant pose alors une jambe « à vide ».
export function bestLegBetween(market, fromIdx, toIdx, f) {
  const deals = enRouteDeals(market, fromIdx, "", toIdx, f).filter((d) => legPasses(d, f));
  if (!deals.length) return null;
  return legFromRoute(deals.reduce((a, b) => (b.margin > a.margin ? b : a)));
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
// Que peut-on faire d'un chargement (origine -> destination) vis-à-vis du parcours en cours ?
// Renvoie { etat: "ajouter" | "deja" | "conflit", leg, fin }.
//
// L'ORDRE DES BRANCHES EST SIGNIFIANT :
//   1. pas de voyage        -> ajouter (on en démarre un, comme le ▶ des tableaux) ;
//   2. ça se RACCORDE       -> ajouter. Testé AVANT « déjà » : sur un parcours cyclique A→B→A dont
//      on est au bout, le chargement A→B est un nouveau tour, pas la jambe 0 qu'on a déjà faite ;
//   3. c'est la jambe COURANTE, puis n'importe quelle jambe planifiée -> déjà (aucune action) ;
//   4. sinon                -> conflit, en nommant la fin du parcours.
//
// « déjà » est l'état NORMAL, pas une anomalie : après tout ▶, syncViewsToJourney pré-remplit
// « En route » avec la station courante, donc la carte affiche précisément la jambe qu'on vient de
// choisir. C'est aussi l'état d'arrivée après un ajout réussi — la phrase sert alors de
// confirmation, à l'endroit exact du clic.
//
// Le raccord passe par journeyConnects et non par une comparaison recopiée : une seule source de
// vérité, qui suivra son durcissement éventuel. Comme elle — et comme legKey — on compare les NOMS
// de station seuls : introduire ici une seconde règle d'identité (nom + système) ferait diverger
// deux définitions du même mot.
export function manifestJourneyState(journey, origin, dest) {
  if (!journey) return { etat: "ajouter" };
  if (journeyConnects(journey, [{ from: origin.name }])) return { etat: "ajouter" };
  const cur = currentLeg(journey);
  if (cur && cur.from === origin.name && cur.to === dest.name) return { etat: "deja", leg: journey.current };
  const i = journey.legs.findIndex((l) => l.from === origin.name && l.to === dest.name);
  if (i >= 0) return { etat: "deja", leg: i };
  const fin = journeyEnd(journey);
  return { etat: "conflit", fin: fin ? fin.name : null };
}

// Jambes qu'une correction de VOLUME (stock ou demande) rebattrait, et qu'il faut donc figer avant
// de l'appliquer. Corriger un stock, c'est dire « j'ai vidé ce terminal » — le plus souvent parce
// qu'on vient d'y charger. Le trajet, lui, est décidé : ses SCU ne doivent pas rétrécir sous les
// pieds du joueur. Les jambes SUIVANTES, elles, doivent bien voir ce qu'il reste.
// Une jambe n'est concernée que si elle touche vraiment ce point : le terminal corrigé est son
// départ (correction d'un stock d'ACHAT) ou son arrivée (correction d'une demande de VENTE), et
// son chargement porte cette commodité. Les autres n'en dépendent pas — les figer les marquerait
// pour rien. Un prix, lui, ne rebat aucune quantité : il ne fige rien.
// `lignesPar[i]` = chargement effectif de la jambe i (l'appelant le connaît, pas nous).
export function legsToPin(legs, lignesPar, commodity, terminal, side) {
  const bouts = legs.map((l) => (side === "buy" ? l.from : l.to));
  return legs.map((_, i) => i).filter((i) =>
    bouts[i] === terminal && (lignesPar[i] || []).some((l) => l.name === commodity)
  );
}

// INTENTION d'un chargement : la seule forme persistable. Jamais un instantané de marché — prix,
// stock, demande et dates sont relus au rendu (cf. hydrateManifestLine), sinon un manifeste
// continuerait d'afficher le prix du jour de l'édition longtemps après qu'UEX l'ait republié.
// Aucun filtre sur `units` : un 0 posé volontairement est une décision de l'utilisateur
// (editLegQty l'autorise explicitement) et doit survivre.
export function manifestIntent(lines) {
  return lines.map((l) => ({ name: l.name, units: l.units }));
}
// Deux intentions décrivent-elles le même chargement ? Sert à ne RIEN persister quand le manifeste
// n'a pas été touché : la jambe reste alors branchée sur le marché et sur les filtres.
export function sameIntent(a, b) {
  return a.length === b.length && a.every((l, i) => l.name === b[i].name && l.units === b[i].units);
}

// Retire un ARRÊT du parcours (stopIndex indexe les STATIONS, pas les jambes).
// `bridge` = jambe de remplacement pour un arrêt du MILIEU, calculée par l'appelant depuis le
// marché (elle reconnecte stations[stopIndex-1] à stations[stopIndex+1]) ; ignorée aux extrémités.
// Renvoie { legs, current, removedFrom, removedCount, insertedCount }, plus `start` quand il ne
// reste qu'un arrêt (parcours « départ posé »), ou null quand il ne reste plus rien du tout.
// Les trois compteurs servent à réindexer les manifestes édités par jambe.
export function removeJourneyStop(journey, stopIndex, bridge) {
  const legs = journey.legs;
  // Parcours déjà réduit à son point de départ : retirer ce dernier arrêt efface tout.
  if (!legs.length) return null;
  let newLegs, removedFrom, removedCount, insertedCount = 0;
  if (stopIndex <= 0) {
    newLegs = legs.slice(1); removedFrom = 0; removedCount = 1;          // 1er arrêt -> 1re jambe
  } else if (stopIndex >= legs.length) {
    newLegs = legs.slice(0, -1); removedFrom = legs.length - 1; removedCount = 1; // dernier arrêt
  } else {
    // Arrêt du milieu : deux jambes disparaissent, remplacées par une seule (le pont).
    newLegs = [...legs.slice(0, stopIndex - 1), bridge, ...legs.slice(stopIndex + 1)];
    removedFrom = stopIndex - 1; removedCount = 2; insertedCount = 1;
  }
  // Une seule jambe, dont on retire une extrémité : l'AUTRE extrémité reste un arrêt légitime.
  // Le parcours ne disparaît donc pas — il retombe sur sa forme « départ posé » (startJourneyAt),
  // celle d'un voyage qu'on vient de commencer, prête à recevoir un nouvel arrêt. Renvoyer null
  // ici faisait s'évanouir les DEUX arrêts d'un coup, alors qu'un seul avait été cliqué.
  if (!newLegs.length) {
    const reste = stopIndex <= 0
      ? { name: legs[0].to, system: legs[0].toSystem }     // on a retiré le départ -> l'arrivée survit
      : { name: legs[0].from, system: legs[0].fromSystem }; // on a retiré l'arrivée -> le départ survit
    return { legs: [], current: 0, start: reste, removedFrom, removedCount, insertedCount };
  }
  // `current` indexe les STATIONS. Retirer l'arrêt `stopIndex` fait reculer d'un cran TOUTES les
  // stations situées à partir de lui : sans ce décalage, le marqueur « je suis ici » sautait à la
  // station suivante, `currentLeg` devenait null (parcours cru terminé) et « En route » se
  // préremplissait avec le mauvais terminal de départ.
  const c = journey.current >= stopIndex ? journey.current - 1 : journey.current;
  return {
    legs: newLegs,
    current: Math.max(0, Math.min(c, newLegs.length)),
    removedFrom, removedCount, insertedCount,
  };
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

// ---------- La soute : ce qui est à bord, et ce qu'on l'a payé (cf. ADR-002) ----------
// Une LIGNE PAR LOT. La même commodité peut y figurer plusieurs fois, à des prix différents : la
// moyenne pondérée était plus simple, les lots sont justes. Chaque lot :
//   { name, units, paid, from, at }   `paid` = prix d'achat au SCU, `at` = horodatage du chargement
//
// `paid` est la SEULE donnée de marché que le dépôt persiste volontairement. Ailleurs la règle est
// stricte — on ne garde que l'intention, jamais un instantané de prix, parce qu'un prix figé
// continuerait de s'afficher longtemps après qu'UEX l'ait republié. `paid` y échappe parce que ce
// n'est pas un prix affiché : c'est le montant d'une transaction qui a eu lieu. Il ne vieillit pas.

// Charge un manifeste dans la soute : un lot par ligne, au prix que l'app venait d'afficher.
// Les lignes sans quantité ne créent pas de lot (on n'a rien chargé), et une ligne déjà à bord
// (`aBord`) n'est pas rechargée — elle ne fait que traverser le manifeste.
export function loadHold(hold, lignes, from, at) {
  const lots = lignes
    .filter((l) => (l.units || 0) > 0 && !l.aBord)
    .map((l) => ({ name: l.name, units: l.units, paid: l.buyPrice || 0, from: from || "", at: at || 0 }));
  return hold.concat(lots);
}

// SCU à bord, toutes commodités confondues — donc la place qu'il reste pour charger.
export const holdScu = (hold) => hold.reduce((s, l) => s + (l.units || 0), 0);
export const freeCargo = (hold, cargo) => Math.max(0, (cargo || 0) - holdScu(hold));

// Regroupe les lots par commodité, pour l'affichage : un total, et le détail dessous.
// `paidMoyen` n'est calculé QUE pour l'affichage — les ventes, elles, consomment lot par lot.
export function holdByCommodity(hold) {
  const par = new Map();
  hold.forEach((l, i) => {
    if (!par.has(l.name)) par.set(l.name, { name: l.name, units: 0, invest: 0, lots: [] });
    const g = par.get(l.name);
    g.units += l.units || 0;
    g.invest += (l.units || 0) * (l.paid || 0);
    g.lots.push({ ...l, i });
  });
  return [...par.values()]
    .map((g) => ({ ...g, paidMoyen: g.units > 0 ? g.invest / g.units : 0 }))
    .sort((a, b) => b.invest - a.invest); // le capital le plus engagé d'abord
}

// Vend `units` SCU d'une commodité au prix `price`. FIFO : le lot le plus ancien part en premier.
// Retenu parce que déterministe et explicable ; « le plus cher d'abord » gonflerait le profit
// affiché sans rien changer à la réalité, et choisir à chaque vente coûterait une décision pour
// un gain nul. Le rendu affiche quel lot part, donc rien ne se décide en silence.
// Renvoie { hold, vendu, recette, cout, profit, lots } — `lots` détaille ce qui a été consommé.
// `at` (nom de station, optionnel) : les lots qu'une vente partielle a laissés à bord ICI portent
// `refuse: <station>` et sont alors SAUTÉS. C'est ce qui protège le résidu de la vente implicite
// déclenchée en avançant d'une étape. Un geste EXPLICITE, lui, ne passe pas `at` et vend quand
// même : l'intention de l'utilisateur prime toujours sur un marqueur posé plus tôt.
export function sellFromHold(hold, name, units, price, at = null) {
  let reste = Math.max(0, Math.floor(units || 0));
  const suivant = [], consommes = [];
  let vendu = 0, cout = 0;
  for (const l of hold) {
    if (l.name !== name || reste <= 0 || (at && l.refuse === at)) { suivant.push(l); continue; }
    const pris = Math.min(l.units || 0, reste);
    if (pris <= 0) { suivant.push(l); continue; }
    reste -= pris; vendu += pris; cout += pris * (l.paid || 0);
    consommes.push({ name: l.name, units: pris, paid: l.paid || 0, from: l.from });
    if ((l.units || 0) > pris) suivant.push({ ...l, units: l.units - pris }); // le lot survit, entamé
  }
  const recette = vendu * (price || 0);
  return { hold: suivant, vendu, recette, cout, profit: recette - cout, lots: consommes };
}

// Marque le reste d'une commodité comme REFUSÉ à cette station : le comptoir n'en a pas voulu.
// Sans ce marqueur, avancer d'une étape — qui vaut « j'ai tout vendu ici » — effacerait le résidu
// au moment exact où il devient le sujet.
export function refuseHere(hold, name, station) {
  return hold.map((l) => (l.name === name ? { ...l, refuse: station } : l));
}

// Prix et capacité d'une commodité à un terminal donné, corrections appliquées. null si ce
// terminal ne la reprend pas. `demand` peut valoir null : capacité INCONNUE, ce qui n'est ni zéro
// ni l'infini — 84 % des points de vente sont dans ce cas.
export function sellableAt(market, terminalIdx, name, resolve) {
  const c = market.commodities.find((x) => x.name === name);
  if (!c) return null;
  const s = c.sells.find((x) => x[0] === terminalIdx);
  if (!s) return null;
  const t = market.terminals[terminalIdx];
  const e = resolve ? resolve(name, t.name, "sell", s[1], s[2], s[3]) : { price: s[1], vol: s[2] };
  return { price: e.price, demand: e.vol, terminal: t.name };
}

// Vend à ce terminal TOUT ce que la soute peut y écouler — c'est la vente implicite : quitter une
// escale sous-entend qu'on y a fait son affaire. Ce qu'une vente partielle y a explicitement laissé
// (`refuse`) traverse l'étape intact. Renvoie { hold, ventes, recette, cout, profit }.
export function sellAllAt(hold, market, terminalIdx, resolve) {
  const t = market.terminals[terminalIdx];
  if (!t) return { hold, ventes: [], recette: 0, cout: 0, profit: 0 };
  let courant = hold;
  const ventes = [];
  let recette = 0, cout = 0;
  for (const nom of [...new Set(hold.map((l) => l.name))]) {
    const pt = sellableAt(market, terminalIdx, nom, resolve);
    if (!pt) continue; // ce terminal ne reprend pas cette commodité : elle reste à bord
    const dispo = courant.reduce((s, l) => s + (l.name === nom && l.refuse !== t.name ? l.units || 0 : 0), 0);
    if (dispo <= 0) continue;
    const r = sellFromHold(courant, nom, dispo, pt.price, t.name);
    if (!r.vendu) continue;
    courant = r.hold;
    recette += r.recette; cout += r.cout;
    ventes.push({ name: nom, units: r.vendu, price: pt.price, recette: r.recette, cout: r.cout, profit: r.profit, lots: r.lots });
  }
  return { hold: courant, ventes, recette, cout, profit: recette - cout };
}

// OÙ ÉCOULER ce qui reste à bord. Dual de `manifestsFrom` : celui-ci remplit la soute par marge
// décroissante, celui-là la VIDE par valeur décroissante, plafonné par la demande.
//
// Le fait qui commande tout, et qui n'est PAS la symétrie qu'on attendrait : 494 points d'achat sur
// 494 publient leur stock (100 %), contre 293 points de vente sur 1 879 (15,6 %) pour la demande.
// `fillCargo` travaille donc sur une donnée complète ; son dual travaille sur une donnée absente
// quatre fois sur cinq. Ce n'est pas le même problème retourné.
// Pour ces 84 %, `demand` vaut null — ni zéro, ni l'infini. On rend donc DEUX chiffres par
// destination, jamais un seul : `absorbe` (optimiste, l'inconnu prend tout) et `garanti`
// (pessimiste, l'inconnu ne prend rien). Le classement suit l'optimiste, et `certitude` dit sur
// quoi il repose — afficher un plafond avec assurance quand la donnée ne le permet pas serait
// exactement le défaut qui a rendu cette fonction nécessaire.
//
// La priorité posée (« la commodité qui rapporte le plus ») joue au CLASSEMENT et non au partage :
// la demande d'une station est par commodité, les résidus ne se disputent donc rien. À valeur
// égale, la destination qui solde le résidu le plus cher passe devant.
export function offloadPlan(market, hold, originIdx, f = {}, resolve = null, autoloadFor = null, limit = 6) {
  if (!hold || !hold.length) return [];
  const origine = market.terminals[originIdx];
  const parNom = holdByCommodity(hold);
  const plusCher = parNom[0] ? parNom[0].name : null; // holdByCommodity trie par capital engagé
  const out = [];

  market.terminals.forEach((t, idx) => {
    if (idx === originIdx) return;                                   // on y est déjà
    if (f.noOutpost && t.outpost) return;
    if (f.sameOnly && origine && t.system !== origine.system) return;
    if (f.sysFilter && t.system !== f.sysFilter) return;

    const lignes = [];
    let scu = 0, garanti = 0, profit = 0, inconnues = 0;
    for (const g of parNom) {
      const c = market.commodities.find((x) => x.name === g.name);
      if (!c) continue;
      const s = c.sells.find((x) => x[0] === idx);
      if (!s) continue;                                              // ce terminal n'en veut pas
      if (!pairEligible(f, c, t, s[3], s[3])) continue;
      const e = resolve ? resolve(g.name, t.name, "sell", s[1], s[2], s[3]) : { price: s[1], vol: s[2] };
      if (!(e.price > 0)) continue;
      // Statut UEX 7 = « saturé ». Mesuré sur l'instantané : les 12 points de statut 7 ont TOUS une
      // capacité publiée à 0, et réciproquement — équivalence parfaite dans les deux sens. C'est le
      // seul zéro fiable de tout le jeu de données. On s'en sert là où la capacité n'est PAS
      // publiée : sans ça, un comptoir saturé passerait pour « inconnu », donc pour « il prend
      // tout » — le pire contresens possible ici. Une correction locale, elle, prime toujours :
      // l'utilisateur a vu le comptoir de ses yeux.
      if (s[4] === 7 && e.vol == null) continue;
      const connue = e.vol != null;
      const prend = connue ? Math.min(g.units, e.vol) : g.units;     // optimiste
      if (prend <= 0) continue;                                      // capacité connue et nulle : saturé
      // Le coût vient des LOTS réellement consommés (FIFO), pas d'une moyenne : c'est la seule
      // façon d'annoncer un profit qui se réalisera tel quel.
      const sim = sellFromHold(hold, g.name, prend, e.price);
      const frais = autoloadFor ? lineHaulFee(prend, { acquired: true }, { buy: null, sell: autoloadFor(t) }) : 0;
      lignes.push({
        name: g.name, absorbe: prend, garanti: connue ? prend : 0, reste: g.units - prend,
        price: e.price, demand: e.vol, connue, profit: sim.profit - frais,
      });
      scu += prend; garanti += connue ? prend : 0; profit += sim.profit - frais;
      if (!connue) inconnues++;
    }
    if (!lignes.length) return;
    lignes.sort((a, b) => b.profit - a.profit);
    out.push({
      idx, terminal: t.name, system: t.system, planet: t.planet, outpost: t.outpost,
      cross: !!origine && t.system !== origine.system,
      lignes, scu, garanti, profit,
      certitude: inconnues === 0 ? "connue" : inconnues === lignes.length ? "inconnue" : "partielle",
      // Solde-t-elle le résidu le plus cher ? À valeur proche, c'est ce qui départage.
      soldeLePlusCher: !!plusCher && lignes.some((l) => l.name === plusCher && l.reste === 0),
      reste: holdScu(hold) - scu,
    });
  });

  return out
    .sort((a, b) => b.profit - a.profit || (b.soldeLePlusCher - a.soldeLePlusCher) || b.garanti - a.garanti)
    .slice(0, limit);
}

// Dépose des SCU à une station : ils quittent la soute SANS être vendus. Troisième sortie du fret,
// et souvent la bonne quand le seul débouché est saturé — on libère la place sans vendre à perte.
// Renvoie { hold, entrepots } ; les lots déposés gardent leur prix payé, c'est du capital immobilisé.
export function storeFromHold(hold, entrepots, name, units, station) {
  const r = sellFromHold(hold, name, units, 0); // même consommation FIFO, sans recette
  if (!r.vendu) return { hold, entrepots };
  const deja = entrepots[station] || [];
  return { hold: r.hold, entrepots: { ...entrepots, [station]: deja.concat(r.lots) } };
}

// ---------- Carte 2D du parcours (cf. ADR-001) ----------
// Projection PURE d'un parcours en coordonnées de dessin. app.js n'a plus qu'à émettre du SVG.
// La géométrie vient de data/starmap.json : `au` (distance à l'étoile) et `lon` (degrés), relevés
// sur la starmap publiée par RSI. On ne dessine QUE des corps qui portent un terminal — c'est ce
// filtre, appliqué à la collecte, qui tient les systèmes du lore hors de la carte.
export const CARTE = { largeur: 680, hauteur: 296, marge: 26 };

// Angle déterministe dérivé d'un nom : deux terminaux d'une même planète ne se superposent pas,
// et la carte ne bouge pas d'un rendu à l'autre (aucun hasard, donc aucun scintillement).
export function nameAngle(nom) {
  let h = 0;
  for (let i = 0; i < nom.length; i++) h = (h * 31 + nom.charCodeAt(i)) % 360;
  return h;
}

// Les rayons réels s'étalent de 0,55 à 13 UA : à l'échelle, tout se tasserait sur l'étoile. On
// compresse par une racine — l'ORDRE et les écarts relatifs survivent, la lisibilité aussi.
// C'est le seul endroit où la carte s'écarte du réel, et c'est assumé (cf. ADR « schéma »).
const rayonRelatif = (au, auMax) => 0.24 + 0.72 * Math.sqrt(Math.max(au, 0) / (auMax || 1));

// Projette le parcours. `stations` = journeyStations(journey) ; `infoTerminal(nom)` rend
// { system, planet } ou null ; `starmap` = data/starmap.json.
// Renvoie tout ce qu'il faut dessiner, en pixels du viewBox — jamais de HTML.
export function journeyMap(stations, current, starmap, infoTerminal, enVol = false) {
  if (!stations || !stations.length) return null;
  const { largeur, hauteur, marge } = CARTE;

  // Un disque par système TRAVERSÉ, dans l'ordre où le parcours les rencontre.
  const ordre = [];
  for (const s of stations) if (s.system && !ordre.includes(s.system)) ordre.push(s.system);
  if (!ordre.length) return null;
  const n = ordre.length;
  const rayon = Math.min((largeur - marge * 2) / (n * 2.35), (hauteur - marge * 2) / 2);
  const systemes = ordre.map((nom, i) => ({
    nom,
    cx: (largeur / n) * (i + 0.5),
    cy: hauteur / 2,
    r: rayon,
    corps: [],
  }));
  const parSysteme = new Map(systemes.map((s) => [s.nom, s]));

  // Les corps du système, aux vraies distances et longitudes.
  for (const sys of systemes) {
    const ancres = (starmap[sys.nom] && starmap[sys.nom].ancres) || {};
    const auMax = Math.max(...Object.values(ancres).map((a) => a.au), 1);
    sys.auMax = auMax;
    for (const [nom, a] of Object.entries(ancres)) {
      const rr = rayonRelatif(a.au, auMax);
      const rad = (a.lon * Math.PI) / 180;
      sys.corps.push({ nom, orbite: rr * sys.r, x: sys.cx + Math.cos(rad) * rr * sys.r, y: sys.cy + Math.sin(rad) * rr * sys.r });
    }
    sys.corps.sort((a, b) => a.orbite - b.orbite);
  }

  // Un arrêt se pose sur son corps parent — sa planète, ou lui-même s'il est une passerelle.
  // Sans corps connu (Levski et tout Nyx : UEX ne les rattache à rien), anneau externe. Cas
  // NOMINAL : 12 terminaux sur 114 sont dans ce cas.
  const rattache = stations.map((st) => {
    const info = infoTerminal(st.name) || {};
    const ancres = (starmap[st.system] && starmap[st.system].ancres) || {};
    const parent = ancres[st.name] ? st.name : (info.planet && ancres[info.planet] ? info.planet : null);
    return { nom: st.name, systeme: st.system, parent, sys: parSysteme.get(st.system) };
  });

  // Deux terminaux d'une MÊME planète (Rod's Fuel et Rat's Nest sont tous deux sur Pyro V) se
  // superposaient : un décalage tiré du nom ne garantit aucune distance minimale, et deux escales
  // à 6 px l'une de l'autre rendent la seconde inatteignable au clic. On répartit donc les escales
  // d'un même corps sur une couronne, à intervalles réguliers — déterministe, et jamais confondu.
  const grappes = new Map();
  rattache.forEach((a, i) => {
    const k = `${a.systeme}|${a.parent || "*"}`;
    if (!grappes.has(k)) grappes.set(k, []);
    grappes.get(k).push(i);
  });

  const borne = (v, max) => Math.max(marge * 0.4, Math.min(max - marge * 0.4, v));
  const arrets = rattache.map((a, i) => {
    const sys = a.sys;
    if (!sys) return { nom: a.nom, systeme: a.systeme, orphelin: true, x: largeur / 2, y: hauteur / 2 };
    const groupe = grappes.get(`${a.systeme}|${a.parent || "*"}`);
    const rang = groupe.indexOf(i), n = groupe.length;
    if (!a.parent) {
      // Orphelins : répartis sur l'anneau externe, à intervalles réguliers.
      const base = nameAngle(a.nom);
      const ang = ((n > 1 ? (360 / n) * rang : base) * Math.PI) / 180;
      return { nom: a.nom, systeme: a.systeme, orphelin: true, x: borne(sys.cx + Math.cos(ang) * sys.r * 1.06, largeur), y: borne(sys.cy + Math.sin(ang) * sys.r * 1.06, hauteur) };
    }
    const ancre = starmap[a.systeme].ancres[a.parent];
    const rr = rayonRelatif(ancre.au, sys.auMax);
    const rad = (ancre.lon * Math.PI) / 180;
    const bx = sys.cx + Math.cos(rad) * rr * sys.r, by = sys.cy + Math.sin(rad) * rr * sys.r;
    // Couronne autour du corps : rayon suffisant pour que les cibles de clic (r = 11) ne se
    // touchent pas, angle de départ vers l'extérieur du système pour ne pas rentrer dans l'étoile.
    const couronne = n > 1 ? Math.max(13, 4 + 3.4 * n) : 7;
    const depart = Math.atan2(by - sys.cy, bx - sys.cx);
    const ang = depart + (n > 1 ? (2 * Math.PI * rang) / n : 0);
    return {
      nom: a.nom, systeme: a.systeme, parent: a.parent, orphelin: false,
      x: borne(bx + Math.cos(ang) * couronne, largeur), y: borne(by + Math.sin(ang) * couronne, hauteur),
    };
  });

  // Les jambes. Un SAUT relie deux systèmes : il ne se dessine pas comme un vol intra-système.
  const jambes = [];
  for (let i = 1; i < arrets.length; i++) {
    const a = arrets[i - 1], b = arrets[i];
    jambes.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, saut: a.systeme !== b.systeme, faite: i <= current });
  }

  // Le vaisseau, sur l'arrêt courant, orienté vers le suivant (ou depuis le précédent au bout).
  // `enVol` : la jambe courante est CHARGÉE, donc on n'est plus à quai — on est parti. Le vaisseau
  // se pose alors entre les deux escales. La carte cesse ainsi de montrer un itinéraire prévu pour
  // montrer où l'on en est réellement (cf. ADR-002).
  const i = Math.max(0, Math.min(current | 0, arrets.length - 1));
  const ici = arrets[i], suiv = arrets[i + 1], prec = arrets[i - 1];
  const vers = suiv || prec || ici;
  const angle = (Math.atan2(vers.y - ici.y, vers.x - ici.x) * 180) / Math.PI + (suiv ? 0 : 180);
  if (enVol && suiv) {
    return {
      largeur, hauteur, systemes, arrets, jambes,
      vaisseau: { x: (ici.x + suiv.x) / 2, y: (ici.y + suiv.y) / 2, angle, arret: i, enVol: true },
    };
  }
  // Un corps qui porte une escale n'a pas besoin de son propre libellé : le nom de l'escale est
  // juste à côté, et les deux se chevauchaient. Le rendu s'en sert pour ne pas l'écrire.
  const occupes = new Set(arrets.filter((a) => a.parent).map((a) => `${a.systeme}|${a.parent}`));
  for (const sys of systemes) for (const b of sys.corps) b.occupe = occupes.has(`${sys.nom}|${b.nom}`);

  return {
    largeur, hauteur, systemes, arrets, jambes,
    vaisseau: { x: ici.x, y: ici.y, angle: vers === ici ? 0 : angle, arret: i, enVol: false },
  };
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
    if (Array.isArray(p.s) && typeof p.s[0] === "string" && p.s[0]) {
      return { legs: [], current: 0, start: { name: p.s[0], system: String(p.s[1] ?? "") } };
    }
    // Le hash est PARTAGEABLE : son contenu vient donc potentiellement d'un tiers. On ne validait
    // que la forme du conteneur, si bien qu'un tuple vide ou mal typé produisait une jambe dont
    // `from`/`system` valaient `undefined` -> TypeError au rendu, et l'app entière tombait.
    if (!Array.isArray(p.l) || !p.l.length) return null;
    const jambeValide = (a) => Array.isArray(a) && typeof a[0] === "string" && a[0] && typeof a[2] === "string" && a[2];
    if (!p.l.every(jambeValide)) return null;
    const legs = p.l.map((a) => ({
      from: a[0], fromSystem: String(a[1] ?? ""), to: a[2], toSystem: String(a[3] ?? ""),
      commodity: String(a[4] ?? ""),
      buyPrice: Number(a[5]) || 0, sellPrice: Number(a[6]) || 0, margin: Number(a[7]) || 0,
    }));
    // `| 0` tronquait sur 32 bits : un `c` géant devenait négatif au lieu d'être borné.
    const c = Math.trunc(Number(p.c)) || 0;
    return { legs, current: Math.max(0, Math.min(legs.length, c)) };
  } catch {
    return null;
  }
}
