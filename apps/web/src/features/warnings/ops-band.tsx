import { formatDateTime } from '@kchs/fields'
import { Button, OpsBand } from '@kchs/ui'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { HAZARD_WORD, pickSituation } from './situation.js'
import { usePublishedWarnings } from './use-situation.js'

/**
 * Полоса обстановки (ADR-0230): пока действует предупреждение уровня I и выше, над
 * рабочей областью видно, что происходит, где и до какого времени. Видны только
 * предупреждения, доступные сотруднику; без доступа или при ошибке полосы нет.
 */
export function WarningsOpsBand() {
  const t = useT()
  const locale = useLocale()
  const openTab = useWorkspace((s) => s.openTab)
  const items = usePublishedWarnings()

  if (!items) return null
  const situation = pickSituation(items, Date.now())
  if (!situation) return null
  const { warning, level, count } = situation

  const until = warning.expires
    ? t('shell.opsBand.until', { time: formatDateTime(warning.expires, { locale }) })
    : null

  const openWarning = () =>
    openTab({
      kind: 'object',
      objectId: warning.id,
      objectType: 'warning',
      title: warning.title,
      icon: 'warning',
      mode: 'permanent',
    })
  const openAll = () =>
    openTab({
      kind: 'screen',
      screen: 'warnings',
      title: t('shell.rail.warnings'),
      icon: 'warnings',
      mode: 'permanent',
    })

  return (
    <OpsBand
      aria-label={t('shell.opsBand.label')}
      level={level}
      levelLabel={t(`shell.opsBand.levels.${HAZARD_WORD[level]}`)}
      title={warning.title}
      details={warning.areas.length > 0 ? warning.areas.join(', ') : null}
      meta={until}
      actions={
        <>
          {count > 1 ? (
            <Button size="sm" variant="ghost" onClick={openAll} title={t('shell.opsBand.all')}>
              {t('shell.opsBand.more', { count: count - 1 })}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={openWarning}>
            {t('common.actions.open')}
          </Button>
        </>
      }
    />
  )
}
