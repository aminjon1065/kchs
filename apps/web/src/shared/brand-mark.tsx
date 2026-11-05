import { cn } from '@kchs/ui'
import { useBranding } from './api/branding.js'

const SIZE = {
  sm: { box: 'size-8 rounded-md', glyph: 'size-5' },
  lg: { box: 'size-11 rounded-lg', glyph: 'size-7' },
} as const

/**
 * Знак продукта: логотип из брендирования (15-admin-operations.md §1) или знак по
 * умолчанию на акценте. Рейл, вход и ситуационный экран показывают один и тот же.
 */
export function BrandMark({
  size = 'sm',
  className,
}: {
  size?: keyof typeof SIZE
  className?: string
}) {
  const branding = useBranding()
  const { box, glyph } = SIZE[size]
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden',
        box,
        branding?.logo ? 'bg-surface' : 'bg-accent text-accent-fg',
        className,
      )}
    >
      {branding?.logo ? (
        <img src={branding.logo} alt="" className="size-full object-contain" />
      ) : (
        <svg viewBox="0 0 32 32" className={glyph} aria-hidden>
          <path
            d="M9 8v16M9 16l8-8M9 16l8 8"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      )}
    </span>
  )
}
