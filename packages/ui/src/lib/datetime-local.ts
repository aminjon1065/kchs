/**
 * Значение `<input type="datetime-local">` ↔ ISO-время. Поле не знает зоны,
 * поэтому оба направления — в часовом поясе браузера: показать UTC-часть
 * ISO-строки значило бы сдвинуть время на смещение пояса при первой правке.
 */
export function toLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function fromLocalInput(raw: string): string {
  return new Date(raw).toISOString()
}
