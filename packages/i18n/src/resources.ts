import { en } from './locales/en.js'
import { ru } from './locales/ru.js'
import { tg } from './locales/tg.js'

export const LOCALES = ['ru', 'tg', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'ru'
export const FALLBACK_LOCALE: Locale = 'ru'

/**
 * Словари интерфейса: вложенные ключи `module.screen.element`. Их читает
 * собственный переводчик (`translate.ts`) — один и тот же на сервере
 * (уведомления, письма) и в клиенте (ADR-0037).
 */
export const dictionaries = { ru, tg, en } as const

/**
 * Самоназвания языков для переключателя. Не переводятся: каждый язык
 * называет себя сам, чтобы его можно было найти из любого интерфейса.
 */
export const LOCALE_NAMES: Record<Locale, { short: string; full: string }> = {
  ru: { short: 'Рус', full: 'Русский' },
  tg: { short: 'Тоҷ', full: 'Тоҷикӣ' },
  en: { short: 'Eng', full: 'English' },
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

export function normalizeLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE
  const short = value.split('-')[0]?.toLowerCase() ?? ''
  return isLocale(short) ? short : DEFAULT_LOCALE
}

export const INTL_LOCALE: Record<Locale, string> = {
  ru: 'ru-RU',
  tg: 'tg-TJ',
  en: 'en-US',
}
