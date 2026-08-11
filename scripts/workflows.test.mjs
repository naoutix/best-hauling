// Invariants des workflows GitHub Actions. Ces réglages ne cassent rien quand ils régressent —
// la CI reste verte — donc rien ne les signale sans un test. Lancer : `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
// Fins de ligne normalisées : git rend ces fichiers en CRLF sous Windows, et toutes les analyses
// ci-dessous raisonnent en lignes. Sans ça, le test passerait sur Linux et échouerait ici.
const lire = (f) => readFileSync(join(WF, f), "utf8").replace(/\r\n/g, "\n");

// Découpe un workflow en blocs de jobs : { nom -> texte du job }. Les jobs sont les clés indentées
// de deux espaces sous `jobs:`. Suffisant ici, et sans dépendance YAML (le dépôt n'en a aucune).
function jobs(yaml) {
  const apres = yaml.slice(yaml.indexOf("\njobs:"));
  const out = {};
  const noms = [...apres.matchAll(/^ {2}([\w-]+):$/gm)];
  noms.forEach((m, i) => {
    const fin = i + 1 < noms.length ? noms[i + 1].index : apres.length;
    out[m[1]] = apres.slice(m.index, fin);
  });
  return out;
}
// Bloc `permissions:` au niveau du workflow (colonne 0), hors de tout job.
const permissionsGlobales = (yaml) => (yaml.match(/^permissions:\n((?: {2}.*\n)+)/m) || [, ""])[1];

test("ci.yml : l'installation est verrouillée sur le lockfile", () => {
  const ci = lire("ci.yml");
  // `npm install` ne vérifie pas que package-lock.json est en phase avec package.json : quand il ne
  // l'est plus, il résout un arbre neuf, ignore les hashes d'intégrité et réécrit le lock dans le
  // runner — le tout au vert. `npm ci` échoue bruyamment à la place.
  const runs = ci.split("\n").filter((l) => l.includes("run:")).join("\n");
  assert.ok(!/\bnpm install\b/.test(runs), "aucune étape ne doit lancer npm install");
  assert.match(runs, /\bnpm ci\b/);
});

test("update-data.yml : les permissions du GITHUB_TOKEN sont scopées par job", () => {
  const y = lire("update-data.yml");
  const g = permissionsGlobales(y);
  // Au niveau du workflow, TOUS les jobs héritent. Le droit de publier sur Pages et de forger un
  // jeton OIDC n'a rien à faire dans le job qui exécute du code et parse du JSON tiers.
  assert.match(g, /contents:\s*read/);
  for (const droit of ["pages: write", "id-token: write", "issues: write"]) {
    assert.ok(!g.includes(droit), `« ${droit} » ne doit pas être accordé globalement`);
  }
  const j = jobs(y);
  assert.match(j.deploy, /pages:\s*write/, "seul deploy publie");
  assert.match(j.deploy, /id-token:\s*write/);
  assert.match(j.notify, /issues:\s*write/, "seul notify écrit dans le tracker");
  assert.ok(!/pages:\s*write/.test(j.build), "le job build ne doit pas pouvoir publier");
  assert.ok(!/id-token:\s*write/.test(j.build), "le job build ne doit pas pouvoir forger d'OIDC");
});

test("le token n'est pas laissé en clair dans les workspaces qui exécutent du code", () => {
  // actions/checkout écrit par défaut le GITHUB_TOKEN dans .git/config. Les jobs qui lancent du
  // code (script de build, dépendances npm, navigateur) n'en ont aucun besoin : ils ne poussent rien.
  for (const [fichier, cibles] of [["update-data.yml", ["build"]], ["ci.yml", ["unit", "e2e"]]]) {
    const j = jobs(lire(fichier));
    for (const nom of cibles) {
      assert.match(j[nom], /persist-credentials:\s*false/, `${fichier} / job ${nom}`);
    }
  }
});
