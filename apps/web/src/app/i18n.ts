import { createTranslator, type Locale } from '@kchs/i18n'
import { useMemo } from 'react'
import { useAppearance } from './appearance.js'

/**
 * Перевод интерфейса. Словари — общие с сервером (`@kchs/i18n`),
 * подстановка и ICU-плюрализация — тот же алгоритм, что в уведомлениях.
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useAppearance((s) => s.locale)
  // Один переводчик на язык: стабильная ссылка не сбрасывает мемоизацию компонентов
  return useMemo(() => createTranslator(locale as Locale), [locale])
}

export function t(key: string, params?: Record<string, string | number>): string {
  return createTranslator(useAppearance.getState().locale as Locale)(key, params)
}
