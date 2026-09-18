import {
  USERS_IMPORT_FIELDS,
  type UsersImportIssue,
  type UsersImportMode,
  type UsersImportReport,
  type UsersImportRowStatus,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  type BadgeProps,
  Button,
  Callout,
  Dialog,
  DialogContent,
  ProgressBar,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileSpreadsheet, FileUp, KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { uploadFile } from '~/features/files/upload.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, usersImportQuery } from '~/shared/api/queries.js'

const API = '/api/v1/admin/users/import'
/** Строк с ошибками на экране; полный список — в отчёте CSV. */
const SHOWN_ROWS = 200

const STATUS_TONES: Record<UsersImportRowStatus, BadgeProps['tone']> = {
  ready: 'accent',
  created: 'success',
  exists: 'neutral',
  error: 'danger',
}

/**
 * Импорт пользователей из Excel (P0-E04 S04, ADR-0041): шаблон → файл в личном
 * пространстве → «Проверить» (ничего не создаёт) → «Импортировать» годные
 * строки → отчёт по строкам и одноразовый файл с временными паролями.
 */
export function UsersImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const input = useRef<HTMLInputElement>(null)
  const { data: me } = useQuery(meQuery())
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [importId, setImportId] = useState('')
  const [credentialsTaken, setCredentialsTaken] = useState(false)
  const { data: status } = useQuery(usersImportQuery(importId))

  const failed = (err: unknown) => {
    const field = err instanceof ApiError ? Object.values(err.fieldErrors())[0] : undefined
    toast.error(
      field?.startsWith('admin.')
        ? t(field)
        : err instanceof Error
          ? err.message
          : t('errors.unknown'),
    )
  }

  const upload = useMutation({
    mutationFn: async (picked: File) => {
      if (!me?.personalSpaceId) throw new Error(t('errors.unknown'))
      return uploadFile({
        file: picked,
        spaceId: me.personalSpaceId,
        onProgress: setUploadProgress,
      })
    },
    onSuccess: (record) => {
      setFile({ id: record.id, name: record.name })
      setImportId('')
      setUploadProgress(null)
    },
    onError: (err) => {
      setUploadProgress(null)
      failed(err)
    },
  })

  const start = useMutation({
    mutationFn: (mode: UsersImportMode) =>
      http.post<{ importId: string }>('/admin/users/import', { fileId: file?.id, mode }),
    onSuccess: (result) => {
      setCredentialsTaken(false)
      setImportId(result.importId)
    },
    onError: failed,
  })

  const done = status?.state === 'succeeded' || status?.state === 'failed'
  const running = Boolean(importId) && !done
  const report = status?.state === 'succeeded' ? status.report : null

  // Созданные сотрудники появляются в списке сразу после импорта
  useEffect(() => {
    if (status?.state === 'succeeded' && status.mode === 'apply') {
      void client.invalidateQueries({ queryKey: ['users'] })
    }
  }, [status?.state, status?.mode, client])

  const reset = () => {
    setFile(null)
    setImportId('')
    setUploadProgress(null)
    setCredentialsTaken(false)
  }

  const describe = (item: UsersImportIssue, columns: UsersImportReport['columns']) => {
    const text = t(`admin.usersImport.issues.${item.code}`, item.params)
    if (!item.field) return text
    // Столбец — как он назван в файле, без пометки обязательности «*»
    const label = (
      columns[item.field] ??
      USERS_IMPORT_FIELDS.find((spec) => spec.key === item.field)?.headers[locale] ??
      item.field
    )
      .replace(/\s*\*\s*$/, '')
      .trim()
    return `${label}: ${text}`
  }

  // «Импортировать» — после проверки этого файла, в которой есть годные строки
  const readyToApply =
    report?.mode === 'check' && report.fileId === file?.id && report.counts.ready > 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent
        size="lg"
        title={t('admin.usersImport.title')}
        description={t('admin.usersImport.description')}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={!file || running || start.isPending}
              loading={start.isPending && start.variables === 'check'}
              onClick={() => start.mutate('check')}
            >
              {t('admin.usersImport.check')}
            </Button>
            {readyToApply ? (
              <Button
                variant="primary"
                disabled={running || start.isPending}
                loading={start.isPending && start.variables === 'apply'}
                onClick={() => start.mutate('apply')}
              >
                {t('admin.usersImport.apply', { count: report.counts.ready })}
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" icon={<Download className="size-3.5" />} asChild>
              <a href={`${API}/template.xlsx`} download>
                {t('admin.usersImport.template')}
              </a>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<FileUp className="size-3.5" />}
              disabled={upload.isPending || running}
              onClick={() => input.current?.click()}
            >
              {t('admin.usersImport.chooseFile')}
            </Button>
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(event) => {
                const picked = event.target.files?.[0]
                event.target.value = ''
                if (picked) upload.mutate(picked)
              }}
            />
            {file ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-secondary">
                <FileSpreadsheet className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                <span className="truncate">{file.name}</span>
              </span>
            ) : null}
          </div>

          {uploadProgress !== null ? (
            <ProgressBar
              value={uploadProgress}
              label={t('admin.usersImport.uploading')}
              showValue
            />
          ) : null}

          {importId && status && !done ? (
            <ProgressBar
              value={status.progress}
              label={t(`admin.usersImport.states.${status.state}`)}
              showValue
            />
          ) : null}

          {status?.state === 'failed' ? (
            <Callout tone="danger" title={t('admin.usersImport.states.failed')}>
              {status.error}
            </Callout>
          ) : null}

          {report ? (
            <ImportReport
              report={report}
              importId={importId}
              describe={describe}
              credentialsAvailable={Boolean(status?.credentialsAvailable) && !credentialsTaken}
              onCredentialsTaken={() => {
                setCredentialsTaken(true)
                // Файл выдаётся один раз: после скачивания сервер его удаляет
                setTimeout(
                  () => void client.invalidateQueries({ queryKey: keys.usersImport(importId) }),
                  1500,
                )
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ImportReport({
  report,
  importId,
  describe,
  credentialsAvailable,
  onCredentialsTaken,
}: {
  report: UsersImportReport
  importId: string
  describe: (item: UsersImportIssue, columns: UsersImportReport['columns']) => string
  credentialsAvailable: boolean
  onCredentialsTaken: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const problems = report.rows.filter((row) => row.status === 'error')

  if (report.fileError) {
    return (
      <Callout tone="danger" title={t('admin.usersImport.fileProblem')}>
        {describe(report.fileError, report.columns)}
      </Callout>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-secondary">
          {t('admin.usersImport.total', { count: report.totalRows })}
        </span>
        {(Object.keys(report.counts) as UsersImportRowStatus[])
          .filter((key) => report.counts[key] > 0)
          .map((key) => (
            <Badge key={key} tone={STATUS_TONES[key]} dot>
              {t(`admin.usersImport.statuses.${key}`)}: {report.counts[key]}
            </Badge>
          ))}
        <Button variant="link" size="sm" icon={<Download className="size-3.5" />} asChild>
          <a href={`${API}/${importId}/report.csv`} download>
            {t('admin.usersImport.downloadReport')}
          </a>
        </Button>
      </div>

      {report.warnings.length > 0 ? (
        <Callout tone="warning" title={t('admin.usersImport.warnings')}>
          <ul className="list-disc pl-4">
            {report.warnings.map((warning) => (
              <li key={JSON.stringify(warning)}>{describe(warning, report.columns)}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {report.mode === 'apply' && report.counts.created > 0 ? (
        credentialsAvailable ? (
          <Callout
            tone="warning"
            title={t('admin.usersImport.credentialsTitle')}
            action={
              <Button variant="primary" size="sm" icon={<KeyRound className="size-3.5" />} asChild>
                <a
                  href={`${API}/${importId}/credentials.csv`}
                  download
                  onClick={onCredentialsTaken}
                >
                  {t('admin.usersImport.downloadCredentials')}
                </a>
              </Button>
            }
          >
            {t('admin.usersImport.credentialsHint', {
              time: report.credentialsExpireAt
                ? formatDateTime(report.credentialsExpireAt, { locale })
                : '—',
            })}
          </Callout>
        ) : (
          <Callout tone="info">{t('admin.usersImport.credentialsTaken')}</Callout>
        )
      ) : null}

      <div>
        <h3 className="mb-1.5 text-xs font-semibold text-fg">
          {t('admin.usersImport.problemRows')}
        </h3>
        {problems.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('admin.usersImport.noProblems')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-fg-muted">
                  <th className="h-7 px-2 font-medium">{t('admin.usersImport.columns.row')}</th>
                  <th className="h-7 px-2 font-medium">{t('admin.usersImport.columns.login')}</th>
                  <th className="h-7 px-2 font-medium">{t('admin.usersImport.columns.name')}</th>
                  <th className="h-7 px-2 font-medium">{t('admin.usersImport.columns.issues')}</th>
                </tr>
              </thead>
              <tbody>
                {problems.slice(0, SHOWN_ROWS).map((row) => (
                  <tr key={row.row} className="border-b border-line align-top last:border-0">
                    <td className="tabular px-2 py-1.5 text-fg-muted">{row.row}</td>
                    <td className="px-2 py-1.5 font-mono">{row.login ?? '—'}</td>
                    <td className="px-2 py-1.5">{row.displayName ?? '—'}</td>
                    <td className="px-2 py-1.5 text-danger">
                      {row.issues.map((item) => describe(item, report.columns)).join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {problems.length > SHOWN_ROWS ? (
              <p className="border-t border-line px-2 py-1.5 text-xs text-fg-muted">
                {t('admin.usersImport.moreRows', { count: problems.length - SHOWN_ROWS })}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
