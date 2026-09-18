import { en } from './locales/en.js'
import { ru } from './locales/ru.js'
import { tg } from './locales/tg.js'

export const LOCALES = ['ru', 'tg', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'ru'
export const FALLBACK_LOCALE: Locale = 'ru'

export const dictionaries = { ru, tg, en } as const

/** i18next-ресурсы: один namespace `app`, вложенные ключи. */
export const resources = {
  ru: { app: ru },
  tg: { app: tg },
  en: { app: en },
} as const

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
