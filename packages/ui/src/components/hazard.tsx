import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn.js'

/**
 * Шкала обстановки (ADR-0230) — одна на карту, полосу оболочки, карточки и ситуационный
 * экран: 0 — норма, I — внимание, II — опасно, III — чрезвычайно. Уровень всегда
 * дублируется римской цифрой, поэтому читается и без различения цвета.
 */
export type HazardLevel = 0 | 1 | 2 | 3

export const HAZARD_LEVELS = [0, 1, 2, 3] as const satisfies readonly HazardLevel[]

/** Знак уровня на шкале — не слово для перевода, а часть самой шкалы. */
export const HAZARD_NUMERAL: Record<HazardLevel, string> = { 0: '0', 1: 'I', 2: 'II', 3: 'III' }

// Полные строки классов: Tailwind собирает только то, что видит в исходнике целиком
const FILL: Record<HazardLevel, string> = {
  0: 'bg-hazard-0 text-hazard-0-fg',
  1: 'bg-hazard-1 text-hazard-1-fg',
  2: 'bg-hazard-2 text-hazard-2-fg',
  3: 'bg-hazard-3 text-hazard-3-fg',
}

const SUBTLE: Record<HazardLevel, string> = {
  0: 'bg-hazard-0-subtle text-hazard-0-text',
  1: 'bg-hazard-1-subtle text-hazard-1-text',
  2: 'bg-hazard-2-subtle text-hazard-2-text',
  3: 'bg-hazard-3-subtle text-hazard-3-text',
}

const BAND: Record<HazardLevel, string> = {
  0: 'border-hazard-0/40 bg-hazard-0-subtle',
  1: 'border-hazard-1/50 bg-hazard-1-subtle',
  2: 'border-hazard-2/40 bg-hazard-2-subtle',
  3: 'border-hazard-3/40 bg-hazard-3-subtle',
}

const MARK_SIZE = {
  sm: 'h-4 min-w-4 rounded-sm px-0.5 text-2xs',
  md: 'h-5 min-w-5 rounded-sm px-1 text-2xs',
  lg: 'size-9 rounded-full text-sm',
} as const

export interface HazardMarkProps extends HTMLAttributes<HTMLSpanElement> {
  level: HazardLevel
  size?: keyof typeof MARK_SIZE
  /** Подпись для чтения с экрана, когда знак стоит без слова рядом. */
  label?: string
}

/** Знак уровня: цветная плашка с римской цифрой. */
export function HazardMark({ level, size = 'md', label, className, ...props }: HazardMarkProps) {
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
      className={cn(
        'tabular inline-flex shrink-0 items-center justify-center font-bold leading-none',
        MARK_SIZE[size],
        FILL[level],
        className,
      )}
      {...props}
    >
      {HAZARD_NUMERAL[level]}
    </span>
  )
}

export interface HazardBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  level: HazardLevel
  children: ReactNode
}

/** Метка уровня в строке списка или карточке: знак и слово на мягком фоне уровня. */
export function HazardBadge({ level, children, className, ...props }: HazardBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md pr-2 pl-1 text-xs font-semibold',
        SUBTLE[level],
        className,
      )}
      {...props}
    >
      <HazardMark level={level} size="sm" />
      {children}
    </span>
  )
}

export interface OpsBandProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  level: HazardLevel
  /** Слово уровня: «Опасно». */
  levelLabel: string
  /** Главное: событие или предупреждение. */
  title: ReactNode
  /** Где: районы, участок. */
  details?: ReactNode
  /** Справа перед действиями: срок действия, «ещё 2». */
  meta?: ReactNode
  actions?: ReactNode
  /** `lg` — ситуационный экран (TV): крупная плашка с рамкой вместо строки оболочки. */
  size?: 'md' | 'lg'
}

/**
 * Полоса обстановки — тонкая строка над рабочей областью, пока действует
 * предупреждение уровня I и выше. Говорит сразу: что, где, до какого времени.
 */
export function OpsBand({
  level,
  levelLabel,
  title,
  details,
  meta,
  actions,
  size = 'md',
  className,
  ...props
}: OpsBandProps) {
  const large = size === 'lg'
  return (
    <div
      role="status"
      className={cn(
        'flex shrink-0 items-center',
        large
          ? 'h-16 gap-5 overflow-hidden rounded-xl border pr-6 text-lg'
          : 'h-(--opsband-h) gap-3 border-b pr-2 text-sm',
        BAND[level],
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'flex h-full shrink-0 items-center font-bold tracking-wide uppercase',
          large ? 'px-6 text-lg' : 'px-3 text-xs',
          FILL[level],
        )}
      >
        {`${HAZARD_NUMERAL[level]} · ${levelLabel}`}
      </span>
      <span className={cn('min-w-0 truncate font-semibold text-fg', large && 'text-xl')}>
        {title}
      </span>
      {details ? <span className="min-w-0 truncate text-fg-secondary">{details}</span> : null}
      <span className="flex-1" />
      {meta ? (
        <span className={cn('tabular shrink-0 text-fg-secondary', large ? 'text-md' : 'text-xs')}>
          {meta}
        </span>
      ) : null}
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}
