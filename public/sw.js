/*
 * Service worker только ради пушей: он живёт отдельно от вкладки и поэтому
 * может показать уведомление, когда приложение закрыто. Кэширования здесь нет
 * намеренно — оффлайн-режим это отдельная история, а лишний кэш ломал бы
 * выкатку новых версий.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const title = payload.title || 'CorNet'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || 'Новое сообщение',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      // Уведомления одного чата схлопываются в одно, чтобы переписка не
      // разворачивала простыню из десятка карточек.
      tag: payload.chatId ? `chat-${payload.chatId}` : undefined,
      renotify: Boolean(payload.chatId),
      data: { chatId: payload.chatId ?? null, messageId: payload.messageId ?? null },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const chatId = event.notification.data?.chatId ?? null

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (!('focus' in client)) continue
        client.postMessage({ type: 'push:open-chat', chatId })
        return client.focus()
      }
      // Открытых окон нет — запускаем приложение и передаём чат через query,
      // postMessage новому окну отправить некому.
      return self.clients.openWindow(chatId ? `/?openChat=${chatId}` : '/')
    }),
  )
})
