// Service worker Shtark Link: показывает push-уведомления, когда приложение закрыто.
// Все адреса считаются от папки приложения (работает и в подпапке, например на GitHub Pages).
const SCOPE = self.registration.scope;
const rel = (u) => new URL(String(u || '').replace(/^\//, ''), SCOPE).href;

self.addEventListener('install', () => self.skipWaiting());
// какой чат открыт на экране в каждой вкладке/окне приложения
const openChats = new Map(); // id клиента -> чат
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'state' && e.source) openChats.set(e.source.id, e.data.chat || null); });
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('sl-app-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// ---------- Быстрый запуск: файлы приложения хранятся на устройстве ----------
// • страница — из сети, но если сеть медленная (дольше 3 с) или её нет — сохранённая копия;
// • файлы с номером версии (app.js?v=…) не меняются — берутся сразу с устройства;
// • картинки, стикеры и прочее — сразу из копии, а свежая версия подкачивается в фоне.
const CACHE = 'sl-app-v1';
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  if (/\/(version\.json|sw\.js)$/.test(url.pathname)) return; // проверка обновлений — всегда из сети
  if (req.mode === 'navigate') return e.respondWith(pageFirstNetwork(url));
  if (url.searchParams.has('v')) return e.respondWith(versioned(req, url));
  if (/\.(js|css|svg|png|jpe?g|webp|gif|json|woff2?|webmanifest)$/i.test(url.pathname)) return e.respondWith(fromCacheThenUpdate(req));
});
async function pageFirstNetwork(url) {
  const cache = await caches.open(CACHE);
  const key = url.origin + url.pathname;
  const net = fetch(key, { cache: 'no-cache' }).then((r) => { if (r.ok) cache.put(key, r.clone()); return r; });
  const timeout = new Promise((res) => setTimeout(res, 3000));
  try {
    const r = await Promise.race([net, timeout]);
    if (r) return r;
  } catch { /* нет сети */ }
  const cached = await cache.match(key);
  if (cached) { net.catch(() => {}); return cached; }
  return net;
}
async function versioned(req, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) {
    await cache.put(req, r.clone());
    // старые версии этого же файла больше не нужны
    for (const k of await cache.keys()) { const u = new URL(k.url); if (u.pathname === url.pathname && u.search !== url.search) cache.delete(k); }
  }
  return r;
}
async function fromCacheThenUpdate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then((r) => { if (r.ok) cache.put(req, r.clone()); return r; });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    // звонок: повторные уведомления заменяют предыдущее (каждое — со звуком и вибрацией)
    if (data.group) {
      const old = await self.registration.getNotifications();
      old.filter((n) => n.data && n.data.group === data.group).forEach((n) => n.close());
    }
    // не показываем: повтор звонка, когда приложение на экране (там играет своя мелодия),
    // и сообщение из чата, который сейчас открыт на экране. iPhone требует показывать каждое уведомление — там показываем всегда.
    const apple = /iPhone|iPad|Macintosh/.test(self.navigator.userAgent);
    if (!apple) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = wins.filter((w) => w.visibilityState === 'visible');
      if (data.seq && visible.length) return;
      if (data.tag && visible.some((w) => w.focused && openChats.get(w.id) === data.tag)) return;
    }
    await self.registration.showNotification(data.title || 'Shtark Link', {
    body: data.body || '',
    icon: rel(data.icon || 'icon-192.png'),
    badge: rel(data.badge || 'icon-192.png'),
    tag: data.tag,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    vibrate: data.requireInteraction ? [500, 200, 500, 200, 500, 200, 500] : undefined,
    silent: false,
    data: { url: rel(data.url || ''), group: data.group || null },
  });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || SCOPE;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(SCOPE));
    if (client) {
      client.postMessage({ type: 'open', url });
      return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});
