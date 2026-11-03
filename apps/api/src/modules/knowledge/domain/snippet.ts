/**
 * Сниппеты выдачи поиска по базе знаний. Web рисует сниппет как HTML (подсветка
 * <mark>), поэтому текст страницы экранируется целиком, а теги появляются только
 * из меток подсветки (ADR-0225).
 */

/** Метки подсветки, которые Meilisearch вставляет в текст выдачи. */
export const HIGHLIGHT_OPEN = '[[kchs-mark]]'
export const HIGHLIGHT_CLOSE = '[[/kchs-mark]]'

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Текст с метками подсветки → безопасный HTML, где размечена только подсветка. */
export function highlightedSnippet(text: string): string {
  return escapeHtml(text)
    .replaceAll(escapeHtml(HIGHLIGHT_OPEN), '<mark>')
    .replaceAll(escapeHtml(HIGHLIGHT_CLOSE), '</mark>')
}
