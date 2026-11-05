import { formatDateTime } from '@kchs/fields'
import { Button, Card, cn, EmptyState, type HazardLevel, HazardMark, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Siren } from 'lucide-react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { warningsQuery } from './queries.js'
import { ACTIVE_WARNINGS_QUERY, activeWarnings, HAZARD_WORD } from './situation.js'

// Полные строки классов: Tailwind собирает только то, что видит целиком
const LEVEL_TEXT: Record<HazardLevel, string> = {
  0: 'text-hazard-0-text',
  1: 'text-hazard-1-text',
  2: 'text-hazard-2-text',
  3: 'text-hazard-3-text',
}

/**
 * «Обстановка» на «Мой день» (ADR-0230): уровень по самому строгому действующему
 * предупреждению и сами предупреждения — что, где, до какого времени. Видны только
 * доступные сотруднику; без действующих — «Норма».
 */
export function SituationWidget() {
  const t = useT()
  const locale = useLocale()
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading, isError } = useQuery({
    ...warningsQuery(ACTIVE_WARNINGS_QUERY),
    refetchInterval: 60_000,
  })

  const active = data ? activeWarnings(data.items, Date.now()) : []
  const level = active[0]?.level ?? 0
  const word = (value: HazardLevel) => t(`shell.opsBand.levels.${HAZARD_WORD[value]}`)

  const openAll = () =>
    openTab({
      kind: 'screen',
      screen: 'warnings',
      title: t('shell.rail.warnings'),
      icon: 'warnings',
      mode: 'permanent',
    })

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Siren className="size-4 text-fg-muted" aria-hidden />
          {t('home.widgets.situation')}
        </span>
      }
      action={
        <Button
          variant="link"
          size="sm"
          iconRight={<ArrowRight className="size-3.5" />}
          onClick={openAll}
        >
          {t('home.inboxAll')}
        </Button>
      }
      padded={false}
    >
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : isError ? (
        <EmptyState compact title={t('home.situation.unavailable')} />
      ) : (
        <>
          <div className="flex items-center gap-3 px-4 py-3">
            <HazardMark level={level} size="lg" />
            <div className="min-w-0">
              <p className={cn('text-md font-semibold', LEVEL_TEXT[level])}>{word(level)}</p>
              <p className="text-xs text-fg-secondary">
                {active.length > 0
                  ? t('home.situation.active', { count: active.length })
                  : t('home.situation.none')}
              </p>
            </div>
          </div>
          {active.length > 0 ? (
            <ul className="divide-y divide-line border-t border-line">
              {active.slice(0, 5).map(({ warning, level: itemLevel }) => (
                <li key={warning.id}>
                  <button
                    type="button"
                    onClick={() =>
                      openTab({
                        kind: 'object',
                        objectId: warning.id,
                        objectType: 'warning',
                        title: warning.title,
                        icon: 'warning',
                        mode: 'permanent',
                      })
                    }
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
                  >
                    <HazardMark level={itemLevel} size="sm" label={word(itemLevel)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{warning.title}</span>
                      {warning.areas.length > 0 ? (
                        <span className="block truncate text-xs text-fg-muted">
                          {warning.areas.join(', ')}
                        </span>
                      ) : null}
                    </span>
                    {warning.expires ? (
                      <span className="tabular shrink-0 text-xs text-fg-secondary">
                        {t('shell.opsBand.until', {
                          time: formatDateTime(warning.expires, { locale }),
                        })}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Card>
  )
}
