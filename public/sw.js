// Service worker: recibe el aviso push (vacío) y muestra el último titular público de trading. No guarda datos ni intercepta páginas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  const show = (n) => self.registration.showNotification(n.title || '📰 Noticias de trading', { body: n.body || 'Hay noticias nuevas de trading.', tag: 'qt-news', renotify: true, icon: '/icon.svg', badge: '/icon.svg', data: { url: '/app' } });
  e.waitUntil(fetch('/api/news/last-push', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then(show));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => { for (const c of cs) { if ('focus' in c) return c.focus(); } return self.clients.openWindow('/app'); }));
});
