import { createTranslator, DEFAULT_LOCALE, type Locale, type Translator } from '@kchs/i18n'
import { createContext, type ReactNode, useContext, useMemo } from 'react'

/**
 * Язык дизайн-системы. Компоненты `@kchs/ui` не содержат текстов: подписи
 * берутся из общих словарей `@kchs/i18n` (ключи `ui.*`) на языке, который
 * задаёт приложение. Без провайдера — язык по умолчанию (`ru`).
 */
const UiLocaleContext = createContext<Locale>(DEFAULT_LOCALE)

export function UiLocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <UiLocaleContext.Provider value={locale}>{children}</UiLocaleContext.Provider>
}

export function useUiLocale(): Locale {
  return useContext(UiLocaleContext)
}

/** Переводчик дизайн-системы на текущем языке интерфейса. */
export function useUiT(): Translator {
  const locale = useUiLocale()
  return useMemo(() => createTranslator(locale), [locale])
}

/**
 * Часовой пояс профиля сотрудника для полей даты-времени дизайн-системы: поле
 * `datetime-local` пояса не знает, и без провайдера оно работало бы в поясе браузера.
 * Без провайдера — пояс браузера (`undefined`).
 */
const UiTimeZoneContext = createContext<string | undefined>(undefined)

export function UiTimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string | undefined
  children: ReactNode
}) {
  return <UiTimeZoneContext.Provider value={timeZone}>{children}</UiTimeZoneContext.Provider>
}

export function useUiTimeZone(): string | undefined {
  return useContext(UiTimeZoneContext)
}
