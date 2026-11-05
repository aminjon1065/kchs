import type { Locale } from '@kchs/i18n'
import { cn } from '@kchs/ui'
import { useBranding } from './api/branding.js'
import { useLocale } from './appearance.js'
import emblemEn from './assets/logo-kchs-en.webp'
import emblemRu from './assets/logo-kchs-ru.webp'
import emblemTg from './assets/logo-kchs-tg.webp'

const SIZE = {
  sm: 'size-8',
  lg: 'size-11',
  /** Тёмная панель входа: эмблема читается целиком. */
  xl: 'size-16',
} as const

/** Эмблема Комитета — надпись на языке интерфейса. */
const EMBLEM: Record<Locale, string> = { ru: emblemRu, tg: emblemTg, en: emblemEn }

/**
 * Знак продукта: логотип из брендирования (15-admin-operations.md §1) или эмблема
 * Комитета на языке интерфейса. Рейл, вход и ситуационный экран показывают один и тот же.
 */
export function BrandMark({
  size = 'sm',
  className,
}: {
  size?: keyof typeof SIZE
  className?: string
}) {
  const branding = useBranding()
  const locale = useLocale()
  const box = SIZE[size]
  if (branding?.logo) {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface',
          box,
          className,
        )}
      >
        <img src={branding.logo} alt="" className="size-full object-contain" />
      </span>
    )
  }
  return (
    <img
      src={EMBLEM[locale] ?? emblemRu}
      alt=""
      className={cn('shrink-0 rounded-full object-contain', box, className)}
    />
  )
}
