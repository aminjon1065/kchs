/*
 * Служебный поток портала: push-уведомления (ADR-0094) и запуск без сети (ADR-0207).
 *
 * Запуск без сети — кэш оболочки, не данных:
 * - страница приложения (`index.html` по любому пути SPA) — «сеть первой»: ответ сети
 *   запоминается вместе с его заголовками, из кэша страница отдаётся только при
 *   сетевой ошибке. Заголовок CSP и nonce в `<meta>` у такого ответа свои и совпадают
 *   (ADR-0043);
 * - собранные файлы `/assets/*` — «кэш первым»: имя несёт хеш содержимого, файл не
 *   меняется;
 * - ответы API, WebSocket и редактора не трогаются: справочники для работы без сети
 *   запоминает само приложение, по сотруднику (ADR-0204).
 */
const SHELL_CACHE = 'kchs-shell-v1'
const ASSETS_CACHE = 'kchs-assets-v1'
const SHELL_KEY = '/__shell'
/** Файлов сборки в кэше — не больше: старые версии вытесняются первыми. */
const ASSETS_LIMIT = 400
const BYPASS = ['/api/', '/ws/', '/collab/']

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSETS_CACHE])
      for (const name of await caches.keys()) {
        if (name.startsWith('kchs-') && !keep.has(name)) await caches.delete(name)
      }
      await self.clients.claim()
      // Страница, открытая до потока, через него не шла: оболочку запомнить сразу
      await refreshShell().catch(() => undefined)
    })(),
  )
})

/** Ответ сети годится в оболочку: страница приложения, без переадресации. */
function shellResponse(response) {
  return (
    response.ok &&
    !response.redirected &&
    response.type === 'basic' &&
    (response.headers.get('content-type') || '').includes('text/html')
  )
}

/** Файлы сборки, на которые ссылается страница: скрипт входа, предзагрузка, стили. */
function assetsOf(html) {
  const out = new Set()
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) out.add(match[1])
  return [...out]
}

async function rememberShell(response) {
  const shell = await caches.open(SHELL_CACHE)
  await shell.put(SHELL_KEY, response.clone())
  await cacheAssets(assetsOf(await response.text()))
}

async function refreshShell() {
  const response = await fetch('/', { credentials: 'same-origin', cache: 'no-store' })
  if (shellResponse(response)) await rememberShell(response)
}

async function trimAssets(cache) {
  const keys = await cache.keys()
  for (const request of keys.slice(0, Math.max(0, keys.length - ASSETS_LIMIT))) {
    await cache.delete(request)
  }
}

async function cacheAssets(urls) {
  const cache = await caches.open(ASSETS_CACHE)
  for (const url of urls) {
    if (!url.startsWith('/assets/') || (await cache.match(url))) continue
    try {
      const response = await fetch(url, { credentials: 'same-origin' })
      if (response.ok && response.type === 'basic') await cache.put(url, response)
    } catch {
      // Нет сети — файл запомнится при следующей загрузке
    }
  }
  await trimAssets(cache)
}

async function navigate(event) {
  try {
    const response = await fetch(event.request)
    if (shellResponse(response)) event.waitUntil(rememberShell(response.clone()))
    return response
  } catch (error) {
    const cached = await caches.match(SHELL_KEY, { cacheName: SHELL_CACHE })
    if (cached) return cached
    throw error
  }
}

async function asset(event) {
  const cache = await caches.open(ASSETS_CACHE)
  const cached = await cache.match(event.request)
  if (cached) return cached
  const response = await fetch(event.request)
  if (response.ok && response.type === 'basic') {
    event.waitUntil(cache.put(event.request, response.clone()).then(() => trimAssets(cache)))
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (BYPASS.some((prefix) => url.pathname.startsWith(prefix))) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(event))
    return
  }
  if (url.pathname.startsWith('/assets/')) event.respondWith(asset(event))
})

/*
 * Приложение после входа подгружает экраны, нужные без сети (сводки), и называет
 * загруженные файлы сборки — поток кладёт их в кэш: страница могла загрузить их
 * раньше, чем поток начал её обслуживать.
 */
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.kind !== 'offline.cache' || !Array.isArray(data.urls)) return
  event.waitUntil(
    (async () => {
      const shell = await caches.match(SHELL_KEY, { cacheName: SHELL_CACHE })
      if (!shell) await refreshShell().catch(() => undefined)
      await cacheAssets(data.urls.filter((url) => typeof url === 'string'))
    })(),
  )
})

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload = {}
  try {
    payload = event.data.json()
  } catch {
    payload = { body: event.data.text() }
  }
  const title = payload.title || 'Портал КЧС'
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
