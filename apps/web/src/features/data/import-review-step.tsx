import type { DatasetRecord, ImportAnalysis, ImportMode, ImportRecord } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import { Button, Callout, Field, KeyValueList, RadioGroup, RadioItem, Spinner } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, XCircle } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import type { MappingRow } from './import-mapping.js'
import { ImportChanges } from './import-review.js'
import { importQuery, isImportFinished } from './queries.js'

/** Шаг 4 мастера импорта (ADR-0046): проверка перед запуском и ход загрузки. */

export function ReviewStep({
  analysis,
  rows,
  fileName,
  dataset,
  name,
  mode,
  review,
  onError,
  onOnErrorChange,
}: {
  analysis: ImportAnalysis
  rows: MappingRow[]
  fileName: string
  dataset?: DatasetRecord
  name: string
  mode: ImportMode
  review: boolean
  onError: 'skip' | 'stop'
  onOnErrorChange: (value: 'skip' | 'stop') => void
}) {
  const t = useT()
  const included = rows.filter((row) => row.include)
  const columns = new Map(analysis.columns.map((column) => [column.index, column]))
  const suspicious = included.filter((row) => (columns.get(row.column)?.invalid ?? 0) > 0)
  const key = dataset
    ? dataset.primaryKey
    : included.filter((row) => row.key).map((r) => r.fieldKey)

  return (
    <div className="flex flex-col gap-4">
      <KeyValueList
        items={[
          { key: 'file', label: t('data.import.review.file'), value: fileName },
          {
            key: 'target',
            label: t('data.import.review.target'),
            value: dataset
              ? `${t('data.import.review.existing', { name: dataset.name })} · ${t(`data.import.mapping.modes.${mode}`)}`
              : t('data.import.review.newDataset', { name: name.trim() }),
          },
          {
            key: 'rows',
            label: t('data.fields.rows'),
            value: t(
              analysis.approx ? 'data.import.structure.rowsApprox' : 'data.import.structure.rows',
              { count: analysis.rowEstimate },
            ),
          },
          {
            key: 'fields',
            label: t('data.import.review.fields'),
            value: included.map((row) => row.label || row.fieldKey).join(', '),
          },
          {
            key: 'key',
            label: t('data.import.review.key'),
            value: key.length > 0 ? key.join(', ') : t('data.import.review.noKey'),
          },
          ...(analysis.geo?.layer
            ? [{ key: 'layer', label: t('data.import.review.layer'), value: analysis.geo.layer }]
            : []),
          ...(analysis.geo?.crs && analysis.geometry
            ? [
                {
                  key: 'crs',
                  label: t('data.import.review.crs'),
                  value: analysis.geo.crsName
                    ? `${analysis.geo.crsName} (${analysis.geo.crs})`
                    : analysis.geo.crs,
                },
              ]
            : []),
          ...(review
            ? [
                {
                  key: 'changes',
                  label: t('data.import.review.changes'),
                  value: t('data.import.review.changesReview'),
                },
              ]
            : []),
        ]}
      />

      {suspicious.length > 0 ? (
        <Callout tone="warning" title={t('data.import.review.problems')}>
          <ul className="list-disc pl-4">
            {suspicious.map((row) => (
              <li key={row.column}>
                {row.name}:{' '}
                {t('data.import.mapping.invalid', { count: columns.get(row.column)?.invalid ?? 0 })}
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout tone="success">{t('data.import.review.noProblems')}</Callout>
      )}

      <Field label={t('data.import.review.onError')}>
        <RadioGroup
          value={onError}
          onValueChange={(value) => onOnErrorChange(value as 'skip' | 'stop')}
          className="flex flex-col gap-2"
        >
          <RadioItem value="skip" label={t('data.import.review.onErrorSkip')} />
          <RadioItem value="stop" label={t('data.import.review.onErrorStop')} />
        </RadioGroup>
      </Field>
    </div>
  )
}

// ─── Ход выполнения ──────────────────────────────────────────────────────────

export function ImportProgress({
  importId,
  dataset,
  onOpen,
  onClose,
  onFinished,
  openLabel,
}: {
  importId: string
  /** Существующий датасет: подписи полей и версия для сводки изменений. */
  dataset?: DatasetRecord
  openLabel?: string | undefined
  onOpen: (datasetId: string) => void
  onClose: () => void
  onFinished: (record: ImportRecord) => void
}) {
  const t = useT()
  const locale = useLocale()
  const { data: record } = useQuery(importQuery(importId))
  const finished = isImportFinished(record?.status)

  const reported = useRef(false)
  useEffect(() => {
    if (record && finished && !reported.current) {
      reported.current = true
      onFinished(record)
    }
  })

  if (!record) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }

  const number = (value: number) => formatNumber(value, {}, { locale })
  let body: ReactNode
  if (record.status === 'review') {
    body = (
      <ImportChanges
        record={record}
        fields={dataset?.fields}
        currentVersion={dataset?.currentVersion}
      />
    )
  } else if (record.status === 'cancelled') {
    body = (
      <div className="flex flex-col gap-4">
        <Callout tone="neutral">{t('data.import.progress.cancelled')}</Callout>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('data.import.progress.close')}
          </Button>
        </div>
      </div>
    )
  } else if (!finished) {
    body = (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Spinner />
        <p className="text-sm text-fg">{t(`data.import.progress.${record.status}`)}</p>
        <p className="text-xs text-fg-muted">{t('data.import.progress.background')}</p>
      </div>
    )
  } else {
    const ok = record.status === 'succeeded'
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {ok ? (
            <CheckCircle2 className="size-6 shrink-0 text-success" aria-hidden />
          ) : (
            <XCircle className="size-6 shrink-0 text-danger" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="text-md font-semibold text-fg">
              {t(ok ? 'data.import.progress.succeeded' : 'data.import.progress.failed')}
            </p>
            <p className="text-xs text-fg-secondary">
              {t('data.import.progress.stats', {
                inserted: number(record.stats.inserted),
                updated: number(record.stats.updated),
                deleted: number(record.stats.deleted),
                errors: number(record.stats.errors),
              })}
            </p>
          </div>
        </div>
        {record.errorSample.length > 0 ? (
          <section aria-label={t('data.import.progress.errors')} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-fg-secondary">
              {t('data.import.progress.errors')}
            </h3>
            <div className="max-h-[320px] overflow-auto rounded-md border border-line">
              <table className="min-w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-surface-2 text-fg-secondary">
                  <tr>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.progress.row')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.mapping.field')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.progress.value')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.progress.reason')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {record.errorSample.map((item) => (
                    <tr key={`${item.row}-${item.column}`} className="border-t border-line">
                      <td className="px-2 py-1 tabular text-fg">{number(item.row)}</td>
                      <td className="px-2 py-1 font-mono text-fg">{item.column}</td>
                      <td className="max-w-[200px] truncate px-2 py-1 text-fg">
                        {item.value ?? '—'}
                      </td>
                      <td className="px-2 py-1 text-fg-secondary">
                        {t(`data.import.errorCodes.${item.reason}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('data.import.progress.close')}
          </Button>
          {ok ? (
            <Button variant="primary" onClick={() => onOpen(record.datasetId)}>
              {openLabel ?? t('data.import.progress.open')}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return body
}
