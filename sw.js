// Service worker Shtark Link: показывает push-уведомления, когда приложение закрыто.
// Все адреса считаются от папки приложения (работает и в подпапке, например на GitHub Pages).
const SCOPE = self.registration.scope;
const rel = (u) => new URL(String(u || '').replace(/^\//, ''), SCOPE).href;

self.addEventListener('install', () => self.skipWaiting());
// какой чат открыт на экране в каждой вкладке/окне приложения
const openChats = new Map(); // id клиента -> чат
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'state' && e.source) openChats.set(e.source.id, e.data.chat || null); });
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
