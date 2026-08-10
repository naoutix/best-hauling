// Service worker : app installable + consultable hors-ligne.
// Coquille (html/js/css/icône) en « stale-while-revalidate » ; données en « réseau
// d'abord, cache en repli » pour rester fraîches en ligne mais disponibles hors-ligne.
const CACHE = "best-hauling-v4";
// Coquille précachée. Les woff2 (mêmes-origine depuis fonts/) sont mis en cache au premier
// rendu par le gestionnaire fetch ci-dessous (stale-while-revalidate) -> hors-ligne complet.
const SHELL = ["./", "./index.html", "./app.js", "./logic.mjs", "./style.css", "./fonts/fonts.css", "./icon.svg", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(req, res) {
  // `clone()` DOIT être appelé SYNCHRONEMENT. `caches.open()` est asynchrone : le temps que sa
  // promesse résolve, la page a déjà consommé le corps de `res` (app.js fait `r.json()` dessus),
  // et `clone()` lève « Response body is already used ». Le `put` ne se faisait donc jamais.
  // Symptôme mesuré avant correction : le cache ne contenait QUE les 8 fichiers de la coquille
  // précachés par `addAll` à l'installation — pas un seul data/*.json, pas une seule police.
  // Autrement dit le repli hors-ligne des données n'avait jamais rien à servir.
  if (res && res.ok) {
    const copie = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copie)).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  if (new URL(req.url).pathname.includes("/data/")) {
    // Réseau d'abord, cache en repli. Une réponse HTTP en ERREUR compte comme un échec : sans ça,
    // le repli n'était branché que sur le REJET de fetch (perte réseau complète), et un 404/503
    // — fenêtre de redéploiement Pages, portail captif qui renvoie sa page — traversait le SW
    // jusqu'à `r.json()` côté app. L'app affichait « Impossible de charger data/routes.json »
    // alors qu'une copie parfaitement exploitable dormait dans le cache.
    e.respondWith(
      fetch(req)
        .then((res) => (res.ok ? putInCache(req, res) : Promise.reject(new Error("HTTP " + res.status))))
        .catch(() => caches.match(req).then((c) => c || Response.error()))
    );
  } else {
    e.respondWith(
      caches.match(req).then((cached) => {
        // `|| Response.error()` : sans rien en cache ET sans réseau, `cached` vaut undefined et
        // respondWith(undefined) lève un TypeError au lieu d'une simple erreur réseau.
        const net = fetch(req).then((res) => putInCache(req, res)).catch(() => cached || Response.error());
        return cached || net;
      })
    );
  }
});
