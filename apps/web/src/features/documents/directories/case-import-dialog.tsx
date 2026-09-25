import type {
  CaseImportMode,
  CaseImportReport,
  CaseImportRow,
  CaseImportRowStatus,
} from '@kchs/contracts'
import {
  Badge,
  type BadgeProps,
  Button,
  Callout,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  Field,
  Input,
  ProgressBar,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileSpreadsheet, FileUp } from 'lucide-react'
import { useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { uploadFile } from '~/features/files/upload.js'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { errorText } from '../status.js'

const TEMPLATE = '/api/v1/cases/import/template.xlsx'

const STATUS_TONES: Record<CaseImportRowStatus, BadgeProps['tone']> = {
  ready: 'accent',
  created: 'success',
  exists: 'neutral',
  error: 'danger',
}

/**
 * Импорт номенклатуры из Excel (N20, ADR-0135): образец — типовая номенклатура →
 * файл в личном пространстве → «Проверить» (ничего не создаёт) → «Завести N дел».
 * Уже заведённые дела пропускаются, строки с ошибками объясняют, что поправить.
 */
export function CaseImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const { data: me } = useQuery(meQuery())
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [report, setReport] = useState<CaseImportReport | null>(null)

  const upload = useMutation({
    mutationFn: async (picked: File) => {
      if (!me?.personalSpaceId) throw new Error(t('errors.unknown'))
      return uploadFile({ file: picked, spaceId: me.personalSpaceId, onProgress: setProgress })
    },
    onSuccess: (record) => {
      setFile({ id: record.id, name: record.name })
      setReport(null)
      setProgress(null)
    },
    onError: (error) => {
      setProgress(null)
      toast.error(errorText(error, t('errors.unknown')))
    },
  })

  const run = useMutation({
    mutationFn: (mode: CaseImportMode) =>
      http.post<CaseImportReport>('/cases/import', {
        fileId: file?.id,
        mode,
        ...(/^\d{4}$/.test(year) ? { year: Number(year) } : {}),
      }),
    onSuccess: (result) => {
      setReport(result)
      if (result.mode === 'apply') {
        toast.show({
          title: t('documents.cases.import.done', { count: result.counts.created }),
          tone: 'success',
        })
        void client.invalidateQueries({ queryKey: ['documents', 'cases'] })
      }
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const readyToApply = report?.mode === 'check' && report.counts.ready > 0

  const columns: DataTableColumn<CaseImportRow>[] = [
    {
      key: 'row',
      header: t('documents.cases.import.columns.row'),
      width: 70,
      cell: (row) => row.row,
    },
    {
      key: 'index',
      header: t('documents.cases.fields.index'),
      width: 100,
      cell: (row) => row.index || '—',
    },
    { key: 'title', header: t('documents.cases.fields.title'), cell: (row) => row.title || '—' },
    {
      key: 'unit',
      header: t('documents.fields.unit'),
      width: 160,
      cell: (row) => row.unitName ?? <span className="text-fg-muted">—</span>,
    },
    {
      key: 'retention',
      header: t('documents.cases.fields.retention'),
      width: 110,
      cell: (row) =>
        row.status === 'error' && row.retentionYears === null
          ? '—'
          : row.retentionYears === null
            ? t('documents.cases.permanent')
            : t('documents.cases.years', { count: row.retentionYears }),
    },
    {
      key: 'status',
      header: t('documents.cases.import.columns.status'),
      width: 260,
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <Badge tone={STATUS_TONES[row.status]} dot>
            {t(`documents.cases.import.statuses.${row.status}`)}
          </Badge>
          {row.messages.map((message) => (
            <span key={message} className="text-xs text-fg-muted">
              {message}
            </span>
          ))}
        </span>
      ),
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={t('documents.cases.import.title')}
        description={t('documents.cases.import.description')}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={!file || run.isPending}
              loading={run.isPending && run.variables === 'check'}
              onClick={() => run.mutate('check')}
            >
              {t('documents.cases.import.check')}
            </Button>
            {readyToApply ? (
              <Button
                variant="primary"
                disabled={run.isPending}
                loading={run.isPending && run.variables === 'apply'}
                onClick={() => run.mutate('apply')}
              >
                {t('documents.cases.import.apply', { count: report.counts.ready })}
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="ghost" size="sm" icon={<Download className="size-3.5" />} asChild>
              <a href={TEMPLATE} download>
                {t('documents.cases.import.template')}
              </a>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<FileUp className="size-3.5" />}
              disabled={upload.isPending || run.isPending}
              onClick={() => input.current?.click()}
            >
              {t('documents.cases.import.chooseFile')}
            </Button>
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              aria-label={t('documents.cases.import.chooseFile')}
              onChange={(event) => {
                const picked = event.target.files?.[0]
                event.target.value = ''
                if (picked) upload.mutate(picked)
              }}
            />
            <Field label={t('documents.cases.import.year')} className="w-40">
              <Input
                inputMode="numeric"
                value={year}
                onChange={(event) => setYear(event.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            </Field>
            {file ? (
              <span className="flex min-w-0 items-center gap-1.5 pb-2 text-xs text-fg-secondary">
                <FileSpreadsheet className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                <span className="truncate">{file.name}</span>
              </span>
            ) : null}
          </div>

          {progress !== null ? (
            <ProgressBar value={progress} label={t('documents.cases.import.uploading')} showValue />
          ) : null}

          {report ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-fg-secondary">
                  {t('documents.cases.import.sheet', { name: report.sheet })}
                </span>
                {(Object.keys(report.counts) as CaseImportRowStatus[])
                  .filter((key) => report.counts[key] > 0)
                  .map((key) => (
                    <Badge key={key} tone={STATUS_TONES[key]} dot>
                      {t(`documents.cases.import.statuses.${key}`)}: {report.counts[key]}
                    </Badge>
                  ))}
              </div>
              {report.rows.length === 0 ? (
                <Callout tone="warning">{t('documents.cases.import.nothing')}</Callout>
              ) : (
                <div className="h-80">
                  <DataTable
                    aria-label={t('documents.cases.import.rows')}
                    rows={report.rows}
                    getRowId={(row) => String(row.row)}
                    columns={columns}
                  />
                </div>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
