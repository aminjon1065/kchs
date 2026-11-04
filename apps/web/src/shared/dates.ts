/**
 * Календарная дата `YYYY-MM-DD` в поясе браузера (ADR-0229). `toISOString()` даёт дату
 * по UTC: с 00:00 до 05:00 по Душанбе в поле «сегодня» подставлялся вчерашний день.
 */
export function localIsoDay(at: Date = new Date()): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
