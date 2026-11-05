import { formatDateTime } from '@kchs/fields'
import { OpsBand } from '@kchs/ui'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { HAZARD_WORD, pickSituation } from './situation.js'
import { usePublishedWarnings } from './use-situation.js'

/**
 * Обстановка на ситуационном экране (ADR-0230): крупная плашка шапки TV-режима. В
 * отличие от полосы оболочки видна всегда — на экране дежурной части «норма» тоже
 * сообщение. Действующих несколько — самое строгое и «ещё N». Экран предупреждений
 * выключен или запрос не прошёл — плашки нет: «норму» без данных не показывают.
 */
export function SituationBand({ className }: { className?: string }) {
  const t = useT()
  const locale = useLocale()
  const items = usePublishedWarnings()
  if (!items) return null

  const situation = pickSituation(items, Date.now())
  if (!situation) {
    return (
      <OpsBand
        size="lg"
        level={0}
        levelLabel={t(`shell.opsBand.levels.${HAZARD_WORD[0]}`)}
        title={t('shell.opsBand.calm')}
        aria-label={t('shell.opsBand.label')}
        className={className}
      />
    )
  }

  const { warning, level, count } = situation
  const meta = [
    warning.expires
      ? t('shell.opsBand.until', { time: formatDateTime(warning.expires, { locale }) })
      : null,
    count > 1 ? t('shell.opsBand.more', { count: count - 1 }) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <OpsBand
      size="lg"
      level={level}
      levelLabel={t(`shell.opsBand.levels.${HAZARD_WORD[level]}`)}
      title={warning.title}
      details={warning.areas.length > 0 ? warning.areas.join(', ') : null}
      meta={meta || null}
      aria-label={t('shell.opsBand.label')}
      className={className}
    />
  )
}
