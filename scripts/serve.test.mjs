// Serveur de dev : ce qu'il ne doit PAS servir, et à qui il ne doit PAS parler.
// Lancer : `node --test` (ou `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticServer } from "./serve.mjs";

// Racine jetable qui imite le dépôt : un fichier public, un .git/config, un .env.
async function racine() {
  const dir = await mkdtemp(join(tmpdir(), "serve-test-"));
  await writeFile(join(dir, "index.html"), "<h1>ok</h1>");
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "config"), "[remote \"origin\"]\n\turl = https://token@example.invalid/x.git\n");
  await writeFile(join(dir, ".env"), "SECRET=1\n");
  return dir;
}

// Démarre sur un port libre (0) et rend une fonction de requête + de quoi arrêter.
// C'est `startStaticServer` qui choisit l'hôte — sinon le test ne prouverait rien de la liaison,
// il vérifierait l'adresse qu'il aurait lui-même passée à listen().
async function demarre(root) {
  const server = startStaticServer(0, root);
  await new Promise((r) => server.once("listening", r));
  const { port, address } = server.address();
  return {
    address,
    get: (p) => fetch(`http://127.0.0.1:${port}${p}`),
    stop: () => new Promise((r) => server.close(r)),
  };
}

test("serve : n'écoute que sur la boucle locale", async () => {
  // Sans hôte explicite, listen() lie TOUTES les interfaces alors que le log annonce localhost :
  // `npm run serve` depuis un Wi-Fi public publiait le dépôt entier à qui passait.
  const dir = await racine();
  const s = await demarre(dir);
  try {
    assert.equal(s.address, "127.0.0.1");
  } finally { await s.stop(); }
});

test("serve : refuse .git/ et .env, sert le reste", async () => {
  const dir = await racine();
  const s = await demarre(dir);
  try {
    assert.equal((await s.get("/index.html")).status, 200, "le contenu public reste servi");
    assert.equal((await s.get("/.git/config")).status, 403);
    assert.equal((await s.get("/.env")).status, 403);
    // Contre-épreuve : le refus doit venir du filtre, pas d'un fichier absent — sinon le test
    // resterait vert le jour où quelqu'un retire le filtre.
    const fuite = await (await s.get("/.git/config")).text();
    assert.ok(!fuite.includes("example.invalid"), "l'URL du remote ne doit jamais sortir");
  } finally { await s.stop(); }
});

test("serve : aucune tentative d'évasion de racine ne rend de contenu", async () => {
  // Il n'existe pas d'évasion : `normalize` retire les « .. » de tête d'un chemin absolu, si bien
  // que ces requêtes retombent DANS la racine et n'y trouvent rien. L'invariant à verrouiller est
  // donc « jamais 200 », pas un code précis — asserter 403 reviendrait à figer un détail
  // d'implémentation que le serveur n'a aucune raison de garantir.
  const dir = await racine();
  const s = await demarre(dir);
  try {
    for (const p of ["/../../etc/passwd", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/..%2f.git/config"]) {
      const r = await s.get(p);
      assert.notEqual(r.status, 200, `${p} ne doit rien rendre`);
    }
  } finally { await s.stop(); }
});
