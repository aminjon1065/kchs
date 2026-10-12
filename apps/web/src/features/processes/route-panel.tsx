import type { LangText } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Route } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { outcomeTone } from './labels.js'
import { objectProcessesQuery, processKeys, processQuery } from './queries.js'
import { RouteLine } from './route-line.js'
import { ProcessStepActions } from './step-actions.js'

function text(value: LangText | null | undefined, locale: string): string | null {
  if (!value) return null
  return (value as Record<string, string | undefined>)[locale] ?? value.ru
}

/**
 * Маршрут объекта модуля (ADR-0202): маршруты объекта — последний первым, линия
 * шагов с назначенными и решениями и действия смотрящего — те же компоненты, что
 * у вкладки «Маршрут» документа. Запуск маршрута — у модуля: панель только
 * показывает и решает.
 */
export function ObjectRoutePanel({
  objectId,
  onChanged,
}: {
  objectId: string
  /** Решение принято: модуль обновляет свою карточку. */
  onChanged?: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const instances = useQuery(objectProcessesQuery(objectId))
  const ordered = [...(instances.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const current = selected ?? ordered[0]?.id ?? null
  const view = useQuery({ ...processQuery(objectId, current ?? ''), enabled: Boolean(current) })

  const refresh = () => {
    void client.invalidateQueries({ queryKey: processKeys.list(objectId) })
    if (current)
      void client.invalidateQueries({ queryKey: processKeys.instance(objectId, current) })
    onChanged?.()
  }

  if (instances.isLoading) return <Skeleton className="h-40 w-full" />
  if (ordered.length === 0) {
    return <EmptyState icon={<Route />} title={t('processes.panel.empty')} />
  }
  const data = view.data
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {ordered.length > 1 ? (
          <Select value={current ?? ''} onValueChange={setSelected}>
            <SelectTrigger className="w-auto min-w-64" aria-label={t('processes.panel.history')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ordered.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {`${text(item.name, locale) ?? item.definitionKey} · ${formatDateTime(item.startedAt, { locale })}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm font-medium text-fg">
            {data ? (text(data.name, locale) ?? data.definitionKey) : null}
          </span>
        )}
        {data ? (
          <Badge
            tone={data.status === 'running' ? 'accent' : outcomeTone(data.outcome)}
            size="sm"
            dot
          >
            {t(`processes.status.${data.status}`)}
          </Badge>
        ) : null}
      </div>
      {data ? (
        <>
          <p className="text-xs text-fg-muted">
            {t('processes.panel.startedBy', {
              name: data.startedBy?.displayName ?? '—',
              date: formatDateTime(data.startedAt, { locale }),
            })}
          </p>
          {data.myActions.length > 0 ? (
            <section className="rounded-md border border-accent bg-surface p-3">
              <ProcessStepActions objectId={objectId} view={data} onDone={refresh} />
            </section>
          ) : null}
          <RouteLine view={data} />
        </>
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </div>
  )
}
