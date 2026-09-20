/*
 * Служебный поток push-уведомлений (ADR-0094). Работает без приложения:
 * показывает уведомление и по клику открывает вкладку объекта в уже открытой
 * странице, если она есть. Кэширования здесь нет — офлайн-режим отдельной
 * задачей фазы 5.
 */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload = {}
  try {
    payload = event.data.json()
  } catch {
    payload = { body: event.data.text() }
  }
  const title = payload.title || 'kchs'
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.category || 'kchs',
    data: { url: payload.url || '/', notificationId: payload.notificationId || null },
    timestamp: Date.now(),
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          client.focus()
          client.postMessage({ kind: 'push.open', url: target })
          return undefined
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
