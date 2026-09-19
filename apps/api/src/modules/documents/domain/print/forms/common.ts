import type { UserRef } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import type { PrintContext } from '../registry.js'

/** Дата без времени (регистрация, срок) — как записана, без сдвига пояса. */
export function dateOnly(value: string | null | undefined, pc: PrintContext): string {
  return value ? formatDate(value, { locale: pc.locale, timezone: 'UTC' }) : ''
}

/** Момент времени — в поясе того, кто печатает. */
export function dateTime(value: string | Date, pc: PrintContext): string {
  return formatDateTime(value, { locale: pc.locale, timezone: pc.timezone })
}

export function person(ref: UserRef | null | undefined): string {
  if (!ref) return ''
  return ref.position ? `${ref.displayName}, ${ref.position}` : ref.displayName
}

/** Левая часть колонтитула: организация, кто и когда напечатал. */
export function footerOf(pc: PrintContext): string {
  return pc.t('documents.print.footer', {
    org: pc.org,
    name: pc.ctx.displayName,
    date: dateTime(pc.now, pc),
  })
}

/** Имя файла без символов, недопустимых в именах файлов и заголовках. */
export function fileNameOf(...parts: Array<string | null | undefined>): string {
  const joined = parts.filter((part): part is string => Boolean(part?.trim())).join(' ')
  const name = [...joined]
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
  return `${name || 'print'}.pdf`
}
