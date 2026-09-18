import { createTranslator, type Locale } from '@kchs/i18n'
import { useAppearance } from './appearance.js'

/**
 * Перевод интерфейса. Словари — общие с сервером (`@kchs/i18n`),
 * подстановка и ICU-плюрализация — тот же алгоритм, что в уведомлениях.
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useAppearance((s) => s.locale)
  return createTranslator(locale as Locale)
}

export function t(key: string, params?: Record<string, string | number>): string {
  return createTranslator(useAppearance.getState().locale as Locale)(key, params)
}
