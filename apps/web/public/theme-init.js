// Тема применяется до первой отрисовки — без вспышки светлого фона.
// Отдельный файл, а не встроенный <script>: CSP разрешает только свои
// скрипты-файлы (script-src 'self', ADR-0043). Подключается синхронно в <head>.
;(() => {
  const root = document.documentElement
  let appearance = {}
  try {
    const stored = JSON.parse(localStorage.getItem('kchs.appearance') || '{}')
    appearance = stored.state || stored
  } catch {
    appearance = {}
  }
  if (appearance.theme === 'light' || appearance.theme === 'dark') {
    root.dataset.theme = appearance.theme
  }
  if (appearance.density) root.dataset.density = appearance.density
  if (appearance.fontSize) root.dataset.fontSize = appearance.fontSize
  if (appearance.locale) root.lang = appearance.locale
})()
