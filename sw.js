// Netwerk eerst, cache enkel als terugval zonder verbinding.
// Gegevens (Supabase) worden nooit gecachet.
const CACHE = "vonnisalert-v5";
const ASSETS = ["/", "/index.html", "/styles.css", "/app.js", "/config.js", "/vendor/supabase-2.119.0.js", "/supabase/functions/_shared/parser.js", "/manifest.webmanifest", "/logo.svg", "/icon-192.png", "/icon-512.png", "/icon-180.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("/index.html"))),
  );
});
