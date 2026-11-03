// House Social — service worker مخصوص Web Push (فاز ۵)
// جدا از service worker خود Flutter (scope: ./push/). متن پیام هرگز در push نیست (E2EE).
'use strict';

const CALL_TTL_MS = 45000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function appUrl(data) {
  const u = new URL('./', self.location.href);
  if (data && data.type) u.searchParams.set('push_type', data.type);
  if (data && data.call_id) u.searchParams.set('call_id', data.call_id);
  if (data && data.conversation_id) u.searchParams.set('conversation_id', data.conversation_id);
  return u.href;
}

async function closeTag(tag) {
  const list = await self.registration.getNotifications({ tag });
  list.forEach((n) => n.close());
}

async function handlePush(msg) {
  const data = msg.data || {};
  const type = msg.type || data.type;

  if (type === 'call_cancel') {
    // زنگ تماس در این مرورگر هم قطع شود
    await closeTag('call-' + data.call_id);
    return;
  }

  // اپ در یک زبانه دیده می‌شود ⇐ realtime خودش اعلان می‌دهد (تکراری نشود)
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.some((w) => w.visibilityState === 'visible')) return;

  const isCall = type === 'call_incoming';
  const title = msg.title || data.title || 'House Social';
  await self.registration.showNotification(title, {
    body: isCall ? 'برای پاسخ لمس کنید' : '',
    tag: msg.tag || undefined,
    renotify: !!msg.tag && !msg.silent,
    silent: !!msg.silent,
    requireInteraction: isCall,
    icon: 'icons/Icon-192.png',
    badge: 'icons/Icon-192.png',
    data: { ...data, type, at: Date.now() },
  });

  if (isCall) {
    // اگر call_cancel نرسید، پس از زمان زنگ خودش بسته شود
    setTimeout(() => closeTag(msg.tag || 'call-' + data.call_id), CALL_TTL_MS);
  }
}

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch (_) {
    msg = {};
  }
  event.waitUntil(handlePush(msg));
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  const stale = data.type === 'call_incoming' && Date.now() - (data.at || 0) > CALL_TTL_MS;
  const target = stale ? { ...data, type: 'call_missed' } : data;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length > 0) {
      const w = wins[0];
      await w.focus();
      w.postMessage({ hs_push_open: target });
      return;
    }
    await self.clients.openWindow(appUrl(target));
  })());
});
