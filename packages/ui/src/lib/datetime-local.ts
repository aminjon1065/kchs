import { zonedDateTime } from '@kchs/fields'

/**
 * Значение `<input type="datetime-local">` ↔ ISO-время. Поле не знает зоны, поэтому время
 * показывается и разбирается в явном поясе — поясе профиля сотрудника (`timeZone`), а без
 * него — в поясе браузера. Показать UTC-часть ISO-строки значило бы сдвинуть время на
 * смещение пояса при первой правке.
 */
export function toLocalInput(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  if (!timeZone) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export function fromLocalInput(raw: string, timeZone?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw)
  if (!timeZone || !match) return new Date(raw).toISOString()
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ]
  return zonedDateTime(year, month, day, hour, minute, 0, timeZone).toISOString()
}
