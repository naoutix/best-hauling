// Collecte la géométrie des systèmes depuis la starmap publiée par RSI, et écrit data/starmap.json.
//
// À LANCER À LA MAIN (`node scripts/fetch-starmap.mjs`), JAMAIS depuis la CI. Trois raisons :
//   1. l'endpoint est interne et non documenté — on ne fait pas dépendre un déploiement de 30 min
//      d'une URL que personne ne nous a promis ;
//   2. la géométrie d'un système ne bouge quasiment jamais, contrairement aux prix ;
//   3. le résultat est COMMITÉ : si l'endpoint ferme, la carte continue de fonctionner.
//
// Le site ne contacte donc jamais robertsspaceindustries.com. Ce script non plus, sauf quand on
// le lance. Voir docs/superpowers/specs/2026-08-12-carte-2d-voyage-adr.md.
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const API = "https://robertsspaceindustries.com/api/starmap/star-systems/";

// Corps dont la valeur publiée est incohérente, corrigés nominativement. Même contrat que
// SCU_RELEVES (cf. build-data.mjs) : chaque entrée est datée, justifiée, et disparaît dès que la
// source se corrige. On ne « lisse » rien d'autre : une donnée qui déplaît n'est pas une erreur.
const CORRECTIONS = {
  // Publié à 0,025 UA, soit VINGT FOIS plus près de l'étoile que Pyro I (0,553) — l'ordre des
  // orbites en devient absurde et la carte, illisible. Valeur reconstruite depuis l'ordre des
  // corps (Pyro I, Monox, Bloom, *Pyro IV*, Pyro V, Terminus) : entre Bloom et Pyro V.
  // Ce n'est PAS une mesure, c'est un placement qui respecte le seul fait dont on soit sûr.
  "Pyro/Pyro IV": { au: 1.9, note: "publié à 0,025 UA — incohérent avec l'ordre des orbites (2026-08-12)" },
};

// Une passerelle s'appelle « <destination> Gateway (<système courant>) » chez UEX, et
// « <système courant> - <destination> » chez RSI. Le nom porte donc le lien, des deux côtés.
const GATEWAY = /^(.+) Gateway \((.+)\)$/;
const sautRSI = (nomTerminal, systeme) => {
  const m = GATEWAY.exec(nomTerminal);
  return m ? `${systeme} - ${m[1]}` : null;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
// Les deux sources ne s'accordent pas sur la casse : UEX écrit « MicroTech », RSI « microTech ».
// Comparer tel quel laissait la plus grosse planète de Stanton sans géométrie, en silence.
const cle = (s) => String(s).trim().toLowerCase();

async function systemeRSI(code) {
  const r = await fetch(API + encodeURIComponent(code), {
    method: "POST",
    headers: { "User-Agent": "best-hauling/1.0 (fan project)", "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`starmap ${code} : HTTP ${r.status}`);
  const j = await r.json();
  const s = j && j.data && j.data.resultset && j.data.resultset[0];
  if (!s) throw new Error(`starmap ${code} : aucun système dans la réponse`);
  return s;
}

async function main() {
  const market = JSON.parse(await readFile(join(DATA, "market.json"), "utf8"));

  // Ce qu'on a le DROIT de dessiner : uniquement ce qui porte un terminal chez UEX. C'est ce
  // filtre — et lui seul — qui empêche les systèmes du lore (Castra, Terra…) et les ajouts
  // annoncés pour Star Citizen 1.0 d'entrer dans la carte.
  const attendu = new Map(); // système -> { planetes:Set, passerelles:Set }
  for (const t of market.terminals) {
    if (!attendu.has(t.system)) attendu.set(t.system, { planetes: new Set(), passerelles: new Set() });
    const e = attendu.get(t.system);
    if (t.planet) e.planetes.add(t.planet);
    else if (GATEWAY.test(t.name)) e.passerelles.add(t.name);
  }

  const out = {};
  let corps = 0, manquants = [];
  for (const [systeme, { planetes, passerelles }] of attendu) {
    const s = await systemeRSI(systeme.toUpperCase());
    const parNom = new Map();
    for (const o of s.celestial_objects || []) {
      const nom = o.name || o.designation;
      if (nom) parNom.set(cle(nom), o);
    }
    const ancres = {};
    const pose = (nom, nomRSI) => {
      const o = parNom.get(cle(nomRSI));
      if (!o || num(o.distance) == null || num(o.longitude) == null) { manquants.push(`${systeme}/${nom}`); return; }
      const fix = CORRECTIONS[`${systeme}/${nom}`];
      ancres[nom] = { au: fix ? fix.au : num(o.distance), lon: num(o.longitude) };
    };
    for (const p of planetes) pose(p, p);
    for (const g of passerelles) pose(g, sautRSI(g, systeme));
    out[systeme] = { ancres };
    corps += Object.keys(ancres).length;
    console.log(`${systeme.padEnd(9)} ${Object.keys(ancres).length} ancres (${planetes.size} planètes, ${passerelles.size} passerelles)`);
  }

  if (manquants.length) console.log(`\n⚠ sans géométrie chez RSI (anneau de repli) : ${manquants.join(", ")}`);
  await writeFile(join(DATA, "starmap.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`\nOK — ${Object.keys(out).length} systèmes, ${corps} ancres → data/starmap.json`);
  console.log("Corrections appliquées :", Object.entries(CORRECTIONS).map(([k, v]) => `${k} (${v.note})`).join(" · ") || "aucune");
}

export { sautRSI, CORRECTIONS, GATEWAY, cle };

// N'exécute la collecte (réseau + écriture) que lancé directement — pas à l'import par les tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("ÉCHEC :", e.message); process.exit(1); });
}
