// Service worker : app installable + consultable hors-ligne.
// Coquille (html/js/css/icône) en « stale-while-revalidate » ; données en « réseau
// d'abord, cache en repli » pour rester fraîches en ligne mais disponibles hors-ligne.
const CACHE = "best-hauling-v3";
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
  if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  if (new URL(req.url).pathname.includes("/data/")) {
    e.respondWith(fetch(req).then((res) => putInCache(req, res)).catch(() => caches.match(req)));
  } else {
    e.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req).then((res) => putInCache(req, res)).catch(() => cached);
        return cached || net;
      })
    );
  }
});
