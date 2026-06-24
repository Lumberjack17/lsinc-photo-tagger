const CACHE = 'photo-tagger-v8';

// App shell — all local assets that make the UI work offline
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/supabase.js',
  '/canvas.js',
  '/editor.js',
  '/scanner.js',
  '/catalog.js',
  '/vision.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
];

// ── Install: cache the app shell ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ───────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch strategy ────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Non-GET (e.g. Claude Vision POST) — straight to network, never cached.
  if (e.request.method !== 'GET') return;

  // Supabase API + Storage — network first, no offline cache (data needs to be live)
  if (url.hostname.includes('supabase.co')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'You are offline. Connect to load photos.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Everything else — cache first, fall back to network, then cache update
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      });
      return cached || network;
    })
  );
});
