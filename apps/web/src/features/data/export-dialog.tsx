import {
  DATASET_EXPORT_FORMATS,
  DATASET_GEO_EXPORT_FORMATS,
  type DatasetExportDownload,
  type DatasetExportFormat,
  type DatasetExportInput,
  type DatasetExportResult,
  type DatasetExportStarted,
  type DatasetRecord,
  type FilterNode,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  ProgressBar,
  RadioGroup,
  RadioItem,
  SegmentedControl,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { exportJobQuery, isJobFinished } from './queries.js'

/** Текущий вид таблицы: фильтры, поиск, сортировка и видимые столбцы в их порядке. */
export interface TableView {
  where?: FilterNode
  search: string
  sort: DatasetExportInput['sort']
  fields: string[]
}

type Scope = 'view' | 'all'

const GEO_FORMATS = new Set<DatasetExportFormat>(DATASET_GEO_EXPORT_FORMATS)
/** Табличные форматы — первым рядом, геоформаты (нужно поле геометрии) — вторым. */
const TABLE_FORMATS = DATASET_EXPORT_FORMATS.filter((format) => !GEO_FORMATS.has(format))

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

function Group({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-fg-secondary">{legend}</legend>
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </fieldset>
  )
}

/**
 * Экспорт датасета (P1-E03 S04, ADR-0056): формат и охват — как в таблице или
 * всё; файл готовит задание с правами пользователя, диалог показывает прогресс
 * и даёт скачать результат.
 */
export function ExportDialog({
  dataset,
  view,
  onClose,
}: {
  dataset: DatasetRecord
  view: TableView
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const hasGeometry = dataset.fields.some((field) => field.type === 'geometry')
  const [format, setFormat] = useState<DatasetExportFormat>('xlsx')
  const [scope, setScope] = useState<Scope>('view')
  const [jobId, setJobId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Другие формат или охват — новый файл: готовый результат больше не относится к выбору
  const choose =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value)
      setJobId(null)
      setFailure(null)
    }

  const start = useMutation({
    mutationFn: () => {
      const body: DatasetExportInput = {
        format,
        sort: scope === 'view' ? view.sort : [],
        ...(scope === 'view' && view.where ? { where: view.where } : {}),
        ...(scope === 'view' && view.search ? { search: view.search } : {}),
        ...(scope === 'view' && view.fields.length > 0 ? { fields: view.fields } : {}),
      }
      return http.post<DatasetExportStarted>(`/datasets/${dataset.id}/exports`, body)
    },
    onSuccess: (started) => {
      setFailure(null)
      setJobId(started.jobId)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  const { data: job } = useQuery({ ...exportJobQuery(jobId ?? ''), enabled: jobId !== null })
  const result = job?.status === 'succeeded' ? (job.result as DatasetExportResult | null) : null
  const failed = job !== undefined && isJobFinished(job.status) && job.status !== 'succeeded'
  const working = jobId !== null && !isJobFinished(job?.status)

  const download = useMutation({
    mutationFn: () => http.get<DatasetExportDownload>(`/datasets/exports/${jobId}/download`),
    // Файл отдаётся с заголовком attachment — страница остаётся на месте
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.export.title', { name: dataset.name })}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {jobId ? t('common.actions.close') : t('common.actions.cancel')}
            </Button>
            {result ? (
              <Button
                variant="primary"
                icon={<Download className="size-4" />}
                loading={download.isPending}
                onClick={() => download.mutate()}
              >
                {t('data.export.download')}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={working}
                loading={start.isPending || working}
                onClick={() => start.mutate()}
              >
                {t('data.export.start')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Group legend={t('data.export.format')} hint={t(`data.export.formatHints.${format}`)}>
            <div className="flex flex-col items-start gap-1.5">
              <SegmentedControl
                value={format}
                onValueChange={choose(setFormat)}
                options={TABLE_FORMATS.map((value) => ({
                  value,
                  label: t(`data.export.formats.${value}`),
                }))}
                aria-label={t('data.export.tableFormats')}
              />
              {hasGeometry ? (
                <SegmentedControl
                  value={format}
                  onValueChange={choose(setFormat)}
                  options={DATASET_GEO_EXPORT_FORMATS.map((value) => ({
                    value,
                    label: t(`data.export.formats.${value}`),
                  }))}
                  aria-label={t('data.export.geoFormats')}
                />
              ) : null}
            </div>
          </Group>
          <Group legend={t('data.export.scope')}>
            <RadioGroup
              value={scope}
              onValueChange={(value) => choose(setScope)(value as Scope)}
              className="flex flex-col gap-2"
              aria-label={t('data.export.scope')}
            >
              <RadioItem value="view" label={t('data.export.scopeView')} />
              <RadioItem value="all" label={t('data.export.scopeAll')} />
            </RadioGroup>
          </Group>
          <p className="text-xs text-fg-muted">{t('data.export.policyNote')}</p>

          {working ? (
            <ProgressBar value={job?.progress ?? 0} label={t('data.export.preparing')} showValue />
          ) : null}
          {result ? (
            <Callout tone={result.truncated ? 'warning' : 'success'}>
              {t('data.export.ready', {
                rows: formatNumber(result.rows, {}, { locale }),
                count: result.rows,
              })}
              {result.truncated ? ` ${t('data.export.truncated')}` : null}
            </Callout>
          ) : null}
          {failed ? (
            <Callout tone="danger">
              {typeof job?.error?.message === 'string'
                ? job.error.message
                : t('data.export.failed')}
            </Callout>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
