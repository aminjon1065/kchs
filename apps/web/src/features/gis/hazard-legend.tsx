import { HAZARD_LEVELS, HazardMark } from '@kchs/ui'
import { useT } from '~/shared/i18n.js'
import type { OverlayRow } from './overlay-layers.js'

/** Слово уровня в словаре оболочки — как у полосы обстановки. */
const LEVEL_WORD = { 0: 'normal', 1: 'caution', 2: 'danger', 3: 'extreme' } as const

/**
 * Легенда шкалы обстановки на карте (ADR-0230): видимые наложения и уровни их зон —
 * знак с римской цифрой и слово, цвет без цифры не встречается. Наложений нет — нет и
 * легенды.
 */
export function HazardLegend({ rows }: { rows: readonly OverlayRow[] }) {
  const t = useT()
  const visible = rows.filter((row) => row.visible)
  if (visible.length === 0) return null
  const levels = HAZARD_LEVELS.filter((level) => visible.some((row) => row.levels.includes(level)))

  return (
    <section
      aria-label={t('shell.opsBand.label')}
      className="pointer-events-auto absolute bottom-10 left-2 z-10 flex max-w-64 flex-col gap-1.5 rounded-lg border border-line-strong bg-surface/95 px-3 py-2 shadow-md"
    >
      <h3 className="text-xs font-semibold text-fg">
        {visible.map((row) => row.label).join(', ')}
      </h3>
      <ul className="flex flex-col gap-1">
        {levels.map((level) => (
          <li key={level} className="flex items-center gap-2 text-xs text-fg-secondary">
            <HazardMark level={level} size="sm" />
            {t(`shell.opsBand.levels.${LEVEL_WORD[level]}`)}
          </li>
        ))}
      </ul>
    </section>
  )
}
