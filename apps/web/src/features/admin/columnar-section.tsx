import type { ColumnarAdmin, ColumnarAdminEntry, ColumnarSettings } from '@kchs/contracts'
import { formatFileSize, formatNumber, formatRelativeTime } from '@kchs/fields'
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton, Switch, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Колоночный tier (06-analytics-engine.md §19, ADR-0109): порог, с которого
 * датасет получает копию в Parquet, и состояние копий. Тяжёлые агрегаты по
 * свежей копии считает DuckDB движка, остальное остаётся в Postgres.
 */

const KEY = ['admin', 'columnar'] as const

const TONE: Record<ColumnarAdminEntry['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  none: 'neutral',
  building: 'warning',
  ready: 'success',
  stale: 'warning',
  failed: 'danger',
}

export function ColumnarSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const rowsId = useId()
  const [draft, setDraft] = useState<ColumnarSettings | null>(null)
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => http.get<ColumnarAdmin>('/admin/data/columnar'),
  })

  const save = useMutation({
    mutationFn: (next: ColumnarSettings) =>
      http.put<ColumnarSettings>('/admin/data/columnar/settings', next),
    onSuccess: () => {
      setDraft(null)
      void client.invalidateQueries({ queryKey: KEY })
      toast.show({ title: t('admin.columnar.saved'), tone: 'success' })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const build = useMutation({
    mutationFn: (datasetId: string) =>
      http.post(`/datasets/${datasetId}/columnar/build`, {}) as Promise<unknown>,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: KEY })
      toast.show({ title: t('data.columnar.buildStarted'), tone: 'success' })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (!data) {
    return (
      <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
        <Skeleton className="h-32" />
      </div>
    )
  }
  const settings = draft ?? data.settings

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
      <Card title={t('admin.columnar.settings')}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{t('admin.columnar.enabled')}</p>
              <p className="text-xs text-fg-secondary">{t('admin.columnar.enabledHint')}</p>
            </div>
            <Switch
              checked={settings.enabled}
              onCheckedChange={(next) => setDraft({ ...settings, enabled: next })}
              aria-label={t('admin.columnar.enabled')}
            />
          </div>
          <Field
            label={t('admin.columnar.minRows')}
            hint={t('admin.columnar.minRowsHint')}
            htmlFor={rowsId}
          >
            <Input
              id={rowsId}
              type="number"
              min={1000}
              step={1000}
              className="w-40"
              disabled={!settings.enabled}
              value={String(settings.minRows)}
              onChange={(event) =>
                setDraft({
                  ...settings,
                  minRows: Math.max(1000, Number(event.target.value) || 1000),
                })
              }
            />
          </Field>
          <div>
            <Button
              variant="primary"
              disabled={!draft}
              loading={save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              {t('common.actions.save')}
            </Button>
          </div>
        </div>
      </Card>

      <Card title={t('admin.columnar.copies')} padded={false}>
        {data.items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={t('admin.columnar.empty')}
              description={t('admin.columnar.emptyHint')}
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((item) => (
              <li key={item.datasetId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm text-fg">
                    {item.name}
                    <Badge size="sm" tone={TONE[item.status]}>
                      {t(`data.columnar.statuses.${item.status}`)}
                    </Badge>
                  </span>
                  <span className="block text-xs text-fg-muted">
                    {item.builtAt
                      ? t('admin.columnar.line', {
                          version: item.version ?? 0,
                          size:
                            item.sizeBytes === null
                              ? '—'
                              : formatFileSize(item.sizeBytes, { locale }),
                          rows:
                            item.rowCount === null
                              ? '—'
                              : formatNumber(item.rowCount, {}, { locale }),
                          when: formatRelativeTime(item.builtAt, { locale }),
                        })
                      : (item.error ?? t('admin.columnar.notBuilt'))}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={item.status === 'building' || !data.settings.enabled}
                  loading={build.isPending && build.variables === item.datasetId}
                  onClick={() => build.mutate(item.datasetId)}
                >
                  {t('data.columnar.rebuild')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
