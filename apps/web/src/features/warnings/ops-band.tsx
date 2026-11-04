import type { WarningSummary } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { Button, type HazardLevel, OpsBand } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { meQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { HAZARD_LEVEL } from './labels.js'
import { warningsQuery } from './queries.js'

const LEVEL_KEY = {
  0: 'normal',
  1: 'caution',
  2: 'danger',
  3: 'extreme',
} as const satisfies Record<HazardLevel, string>

/** Действует сейчас: опубликовано, не учения и не отмена, срок не истёк. */
function isActive(warning: WarningSummary, now: number): boolean {
  return (
    warning.status === 'published' &&
    warning.capStatus === 'Actual' &&
    warning.msgType !== 'Cancel' &&
    (warning.expires === null || Date.parse(warning.expires) > now)
  )
}

const issuedAt = (warning: WarningSummary): number =>
  Date.parse(warning.publishedAt ?? warning.updatedAt)

/**
 * Что показать в полосе: самое строгое из действующих (при равной строгости — самое
 * свежее) и сколько их всего. Уровень 0 полосу не поднимает — это обычный фон.
 */
export function pickSituation(
  items: readonly WarningSummary[],
  now: number,
): { warning: WarningSummary; level: HazardLevel; count: number } | null {
  const active = items
    .filter((warning) => isActive(warning, now))
    .map((warning) => ({ warning, level: HAZARD_LEVEL[warning.severity] }))
    .filter((item) => item.level > 0)
  if (active.length === 0) return null
  active.sort((a, b) => b.level - a.level || issuedAt(b.warning) - issuedAt(a.warning))
  const [top] = active
  return top ? { ...top, count: active.length } : null
}

/**
 * Полоса обстановки (ADR-0230): пока действует предупреждение уровня I и выше, над
 * рабочей областью видно, что происходит, где и до какого времени. Видны только
 * предупреждения, доступные сотруднику; без доступа или при ошибке полосы нет.
 */
export function WarningsOpsBand() {
  const t = useT()
  const locale = useLocale()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: me } = useQuery(meQuery())
  const hidden = new Set<string>(me?.hiddenScreens ?? []).has('warnings')

  const { data } = useQuery({
    ...warningsQuery({ status: 'published', limit: 50 }),
    enabled: Boolean(me) && !hidden,
    refetchInterval: 60_000,
    retry: false,
  })

  if (hidden || !data) return null
  const situation = pickSituation(data.items, Date.now())
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
      levelLabel={t(`shell.opsBand.levels.${LEVEL_KEY[level]}`)}
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
