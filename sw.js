// Bump VERSION on every deploy so phones pick up the new files.
const VERSION = 'mony-v13';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './sync.js', './config.js', './privacy.html', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

// cache: 'reload' skips the browser's HTTP cache (GitHub Pages allows 10 minutes),
// so a new version never gets stored with stale copies of the old files.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Cache first (works offline), revalidate with the server in the background.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(req.url, { cache: 'no-cache' })
      .then(res => { if (res.ok && req.mode !== 'navigate') cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  }));
});
