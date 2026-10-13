/**
 * Подготовка к запуску без сети (ADR-0207): после входа приложение в простое
 * подгружает экраны, которые нужны без связи, и называет служебному потоку все уже
 * загруженные файлы сборки — первая страница грузилась раньше, чем поток начал её
 * обслуживать, и сам он их не видел.
 */

/** Сколько ждать служебный поток: без него (приватный режим) подготовки просто нет. */
const READY_TIMEOUT_MS = 10_000

async function activeWorker(): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null
  const ready = navigator.serviceWorker.ready.then((registration) => registration.active)
  const timeout = new Promise<null>((resolve) =>
    window.setTimeout(() => resolve(null), READY_TIMEOUT_MS),
  )
  return Promise.race([ready, timeout])
}

/** Файлы `/assets/*`, которые страница уже загрузила. */
export function loadedAssets(entries: ReadonlyArray<{ name: string }>, origin: string): string[] {
  const out = new Set<string>()
  for (const entry of entries) {
    try {
      const url = new URL(entry.name)
      if (url.origin === origin && url.pathname.startsWith('/assets/')) out.add(url.pathname)
    } catch {
      // не адрес — пропустить
    }
  }
  return [...out]
}

export async function prepareOffline(warm: () => Promise<unknown>): Promise<void> {
  await warm().catch(() => undefined)
  const worker = await activeWorker()
  if (!worker) return
  const urls = loadedAssets(performance.getEntriesByType('resource'), window.location.origin)
  worker.postMessage({ kind: 'offline.cache', urls })
}
