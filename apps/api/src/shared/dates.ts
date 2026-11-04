import { config } from './config/index.js'

/**
 * Календарная дата `YYYY-MM-DD` в поясе установки (ADR-0229): `toISOString()` даёт
 * дату по UTC, и с 00:00 до 05:00 по Душанбе дата поступления выходила вчерашней.
 */
export function localToday(at: Date = new Date(), timezone: string = config().TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
