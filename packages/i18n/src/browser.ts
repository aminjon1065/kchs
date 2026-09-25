import type { Dictionary } from './locales/ru.js'
import { ru } from './locales/ru.js'
import { isLocaleLoaded, registerLocale } from './registry.js'
import type { Locale } from './resources.js'
import type { DeepPartial } from './types.js'

/**
 * Вход для браузера (условие `browser` в package.json, ADR-0166). Словарь каждого
 * языка — около трети основного бандла, а сотруднику нужен один: в бандле только
 * основной `ru`, `tg` и `en` — отдельные чанки, их загружает `loadLocale()` до
 * первого рисования и при смене языка. Набор экспортов — как у `index.ts`.
 */
registerLocale('ru', ru)

const loaders: Record<Exclude<Locale, 'ru'>, () => Promise<DeepPartial<Dictionary>>> = {
  tg: () => import('./locales/tg.js').then((module) => module.tg),
  en: () => import('./locales/en.js').then((module) => module.en),
}

/** Загрузить словарь языка; уже загруженный — сразу. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (locale === 'ru' || isLocaleLoaded(locale)) return
  registerLocale(locale, await loaders[locale]())
}

export { isLocaleLoaded } from './registry.js'
export * from './resources.js'
export * from './translate.js'
export type { DeepPartial, TranslateParams } from './types.js'
