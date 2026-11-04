import { useWorkspace } from '~/shared/workspace/store.js'

const RELOAD_KEY = 'kchs.chunkReloadAt'
/** Чаще раза в минуту не перезагружаемся: если и новая версия не грузится — покажет граница. */
const RELOAD_WINDOW_MS = 60_000

/**
 * После выкатки открытая вкладка браузера держит старые адреса чанков, и сервер
 * отвечает на них 404 (ADR-0228). Vite сообщает об этом событием `vite:preloadError`:
 * одна перезагрузка подтягивает новую версию. Не перезагружаем без сети (не поможет),
 * при несохранённых правках во вкладках (потеряются) и повторно в течение минуты (цикл) —
 * тогда ошибку показывает граница вкладки с кнопкой «Обновить страницу».
 */
export function installChunkReload(): () => void {
  const onPreloadError = (event: Event) => {
    if (!navigator.onLine) return
    const dirty = Object.values(useWorkspace.getState().tabs).some((tab) => tab.dirty)
    if (dirty) return
    let last = 0
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
      if (Date.now() - last < RELOAD_WINDOW_MS) return
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    } catch {
      // Хранилище сессии недоступно — без отметки цикл не исключить, перезагрузку не делаем
      return
    }
    event.preventDefault()
    window.location.reload()
  }
  window.addEventListener('vite:preloadError', onPreloadError)
  return () => window.removeEventListener('vite:preloadError', onPreloadError)
}
