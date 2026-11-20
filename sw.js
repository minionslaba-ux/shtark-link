// Service worker Shtark Link: показывает push-уведомления, когда приложение закрыто.
// Все адреса считаются от папки приложения (работает и в подпапке, например на GitHub Pages).
const SCOPE = self.registration.scope;
const rel = (u) => new URL(String(u || '').replace(/^\//, ''), SCOPE).href;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    // звонок: повторные уведомления заменяют предыдущее (каждое — со звуком и вибрацией)
    if (data.group) {
      const old = await self.registration.getNotifications();
      old.filter((n) => n.data && n.data.group === data.group).forEach((n) => n.close());
    }
    // повтор звонка не нужен, если приложение открыто на экране (там играет своя мелодия) — кроме iPhone: он требует показывать каждое уведомление
    if (data.seq) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const apple = /iPhone|iPad|Macintosh/.test(self.navigator.userAgent);
      if (!apple && wins.some((w) => w.visibilityState === 'visible')) return;
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
