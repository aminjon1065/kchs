import type { DatasetField, ImportDiffRow, ImportRecord } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  StatTile,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { dataKeys } from './queries.js'

type Kind = 'added' | 'changed' | 'deleted'
const EMPTY = '—'

/**
 * Изменения перед публикацией (ADR-0068, сценарий E): сводка «добавится —
 * изменится — удалится» по ключу, примеры строк «было → стало», публикация или
 * отмена импорта. Показывается в мастере импорта и на вкладке «Импорты».
 */
export function ImportChanges({
  record,
  fields,
  currentVersion,
  onDone,
}: {
  record: ImportRecord
  /** Поля датасета — подписи вместо ключей. */
  fields?: DatasetField[]
  /** Текущая версия датасета: другая, чем при сравнении, — сводка могла устареть. */
  currentVersion?: number
  onDone?: (record: ImportRecord) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const action = useMutation({
    mutationFn: (kind: 'publish' | 'cancel') =>
      http.post<ImportRecord>(`/datasets/imports/${record.id}/${kind}`, {}),
    onSuccess: (next) => {
      setFailure(null)
      client.setQueryData(dataKeys.import(record.id), next)
      void client.invalidateQueries({ queryKey: dataKeys.imports(record.datasetId) })
      onDone?.(next)
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const diff = record.diff
  if (!diff) return null
  const number = (value: number) => formatNumber(value, {}, { locale })
  const labels = new Map(
    (fields ?? []).map((field) => [field.key, field.label[locale] ?? field.label.ru ?? field.key]),
  )
  const kinds: Kind[] = diff.deleted > 0 ? ['changed', 'added', 'deleted'] : ['changed', 'added']
  const samples =
    diff.samples.added.length + diff.samples.changed.length + diff.samples.deleted.length
  const hidden = samples === 0 && diff.added + diff.changed + diff.deleted > 0
  const stale = currentVersion !== undefined && currentVersion !== diff.baseVersion
  const first = kinds.find((kind) => diff[kind] > 0) ?? 'changed'

  return (
    <section aria-label={t('data.import.changes.title')} className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-md font-semibold text-fg">{t('data.import.changes.title')}</h3>
        <p className="text-xs text-fg-secondary">
          {t('data.import.changes.summary', { version: diff.baseVersion })}
        </p>
      </div>
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      {stale ? (
        <Callout tone="warning">
          {t('data.import.changes.stale', { current: currentVersion, base: diff.baseVersion })}
        </Callout>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label={t('data.import.changes.added')} value={number(diff.added)} />
        <StatTile label={t('data.import.changes.changed')} value={number(diff.changed)} />
        <StatTile label={t('data.import.changes.deleted')} value={number(diff.deleted)} />
        <StatTile label={t('data.import.changes.unchanged')} value={number(diff.unchanged)} />
      </div>
      {diff.duplicates > 0 ? (
        <Callout
          tone="warning"
          title={`${t('data.import.changes.duplicates')}: ${number(diff.duplicates)}`}
        >
          {t('data.import.changes.duplicatesHint')}
        </Callout>
      ) : null}
      {hidden ? (
        <Callout tone="neutral">{t('data.import.changes.hidden')}</Callout>
      ) : (
        <Tabs defaultValue={first} className="flex flex-col gap-2">
          <TabsList aria-label={t('data.import.changes.kinds')}>
            {kinds.map((kind) => (
              <TabsTrigger key={kind} value={kind} count={diff[kind]}>
                {t(`data.import.changes.${kind}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {kinds.map((kind) => (
            <TabsContent key={kind} value={kind}>
              <ChangeTable
                rows={diff.samples[kind]}
                total={diff[kind]}
                label={(key) => labels.get(key) ?? key}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          disabled={action.isPending}
          loading={action.isPending && action.variables === 'cancel'}
          onClick={() => action.mutate('cancel')}
        >
          {t('data.import.changes.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={action.isPending}
          loading={action.isPending && action.variables === 'publish'}
          onClick={() => action.mutate('publish')}
        >
          {t('data.import.changes.publish')}
        </Button>
      </div>
    </section>
  )
}

function ChangeTable({
  rows,
  total,
  label,
}: {
  rows: ImportDiffRow[]
  total: number
  label: (key: string) => string
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-fg-muted">{t('data.import.changes.none')}</p>
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="max-h-[320px] overflow-auto rounded-md border border-line">
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-surface-2 text-fg-secondary">
            <tr>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('data.import.changes.key')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('data.import.changes.row')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('data.import.changes.values')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.key.join('|')}-${row.row ?? ''}`}
                className="border-t border-line align-top"
              >
                <td className="px-2 py-1.5 font-mono text-fg">
                  {row.key.map((part) => part ?? EMPTY).join(', ')}
                </td>
                <td className="px-2 py-1.5 tabular text-fg-secondary">
                  {row.row === null ? EMPTY : formatNumber(row.row, {}, { locale })}
                </td>
                <td className="px-2 py-1.5">
                  <ul className="flex flex-col gap-0.5">
                    {row.restored ? (
                      <li>
                        <Badge size="sm" tone="warning">
                          {t('data.import.changes.restored')}
                        </Badge>
                      </li>
                    ) : null}
                    {row.changes.map((change) => (
                      <li key={change.field} className="flex flex-wrap items-center gap-1 text-fg">
                        <span className="text-fg-secondary">{label(change.field)}:</span>
                        {change.masked ? (
                          <span className="text-fg-muted">{t('data.import.changes.masked')}</span>
                        ) : (
                          <>
                            {change.before !== null ? (
                              <span className="max-w-[240px] truncate text-fg-muted line-through">
                                {change.before}
                              </span>
                            ) : null}
                            {change.before !== null && change.after !== null ? (
                              <ArrowRight className="size-3 text-fg-muted" aria-hidden />
                            ) : null}
                            {change.after !== null ? (
                              <span className="max-w-[240px] truncate">{change.after}</span>
                            ) : change.before === null ? (
                              <span className="text-fg-muted">{EMPTY}</span>
                            ) : null}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length ? (
        <p className="text-2xs text-fg-muted">
          {t('data.import.changes.shown', { count: rows.length })}
        </p>
      ) : null}
    </div>
  )
}
