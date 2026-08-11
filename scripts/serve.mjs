#!/usr/bin/env node
// Serveur statique minimal, sans dépendance — pour les tests Playwright et le dev local.
// Usage : node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

const port = Number(process.argv[2]) || 4173;
// Boucle locale explicite. Sans hôte, `listen` lie TOUTES les interfaces alors que le log annonçait
// localhost : `npm run serve` depuis un Wi-Fi public ou un LAN d'entreprise publiait le répertoire
// courant à qui passait.
// Le log et playwright.config.mjs disent bien « 127.0.0.1 » et non « localhost » : sous Windows,
// localhost résout d'abord en ::1, que ce serveur ne sert plus. Chromium retombe sur IPv4, mais
// après un échec de connexion — mesuré à 211 ms par requête contre 1,5 ms en visant l'IPv4
// directement. Invisible à l'œil, suffisant pour faire perdre une course de chargement en test.
const HOST = "127.0.0.1";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};
// La racine servie est le dépôt lui-même : elle contient `.git/` — dont `config`, avec l'URL du
// remote et d'éventuels identifiants — et tout fichier non versionné qui traîne (`.env`, notes,
// clés déposées le temps d'un test). Rien de cela n'a à sortir d'un serveur de développement.
const DENY = /(^|[\\/])\.(git|env)([\\/]|$)/i;

export function createStaticServer(root = process.cwd()) {
  return createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const file = join(root, normalize(p));
      // `root + sep`, et non `root` seul : un dossier frère nommé « <root>-autre » satisferait le
      // préfixe nu. Aucun chemin d'évasion connu n'y mène aujourd'hui (normalize retire les « .. »
      // de tête d'un chemin absolu), mais la comparaison ne doit pas dépendre de cette propriété.
      if (!file.startsWith(root + sep) || DENY.test(file.slice(root.length))) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
}

// Le choix de l'hôte appartient à cette fonction, pas à l'appelant : c'est ce qui permet de le
// VÉRIFIER par un test. Un test qui passerait lui-même « 127.0.0.1 » à listen() ne prouverait rien.
export function startStaticServer(listenPort = port, root = process.cwd()) {
  return createStaticServer(root).listen(listenPort, HOST);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startStaticServer(port).on("listening", () => console.log(`serve → http://127.0.0.1:${port}`));
