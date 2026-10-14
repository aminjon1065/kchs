import type { GovEdmsIntakeRecord } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  EmptyState,
  FileDropzone,
  PanelToolbar,
  ProgressBar,
  SegmentedControl,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Landmark, Upload } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { errorText } from '../status.js'
import { type ImportDocument, type ImportMode, isZip, planImport } from './import-plan.js'
import {
  duplicatesOf,
  type GovEdmsScope,
  govEdmsIntakePage,
  govEdmsKeys,
  importDocument,
  sha256Hex,
} from './queries.js'

/**
 * Очередь «Из госЭДО» (ADR-0219): документы, выгруженные из закрытой государственной
 * системы ЭДО и заведённые черновиками входящих. Реквизиты подставляются из текста
 * основного файла, повтор отмечен предупреждением; регистрация — обычной карточкой.
 */
export function GovEdmsScreen() {
  const t = useT()
  const locale = useLocale()
  const openTab = useWorkspace((s) => s.openTab)
  const [scope, setScope] = useState<GovEdmsScope>('pending')
  const [uploading, setUploading] = useState(false)

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: govEdmsKeys.intake(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => govEdmsIntakePage(scope, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Реквизиты подставляются, когда движок извлечёт текст: пока есть ждущие — опрос
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((item) => item.prefillStatus === 'waiting'),
      )
        ? 5000
        : false,
  })
  const items = data?.pages.flatMap((page) => page.items) ?? []

  const open = (item: GovEdmsIntakeRecord) =>
    openTab({
      kind: 'object',
      objectId: item.document.id,
      objectType: 'document',
      title: item.document.title,
      mode: 'permanent',
    })

  return (
    <section aria-label={t('documents.govEdms.title')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('documents.govEdms.title')}</h1>}
        right={
          <>
            <SegmentedControl
              size="sm"
              aria-label={t('documents.govEdms.scopeLabel')}
              value={scope}
              onValueChange={(next) => setScope(next as GovEdmsScope)}
              options={[
                { value: 'pending', label: t('documents.govEdms.filters.pending') },
                { value: 'all', label: t('documents.govEdms.filters.all') },
              ]}
            />
            <Button
              variant="primary"
              size="sm"
              icon={<Upload className="size-3.5" />}
              onClick={() => setUploading(true)}
            >
              {t('documents.govEdms.upload')}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Landmark className="size-6" />}
            title={t('documents.govEdms.empty')}
            description={t('documents.govEdms.emptyHint')}
            action={
              <Button variant="primary" onClick={() => setUploading(true)}>
                {t('documents.govEdms.upload')}
              </Button>
            }
          />
        ) : (
          <ul
            aria-label={t('documents.govEdms.title')}
            className="flex flex-col divide-y divide-line"
          >
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => open(item)}
                  className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">
                      {item.document.title}
                    </span>
                    <Badge size="sm" tone={item.document.status === 'draft' ? 'accent' : 'success'}>
                      {t(`documents.status.${item.document.status}`)}
                    </Badge>
                    {item.document.regNumber ? (
                      <span className="text-xs text-fg-muted tabular">
                        № {item.document.regNumber}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-fg-secondary">
                    {[
                      item.document.correspondent?.name ?? item.prefill?.sender ?? null,
                      item.document.externalNumber
                        ? t('documents.govEdms.externalNumber', {
                            number: item.document.externalNumber,
                            date: item.document.externalDate
                              ? formatDate(item.document.externalDate, { locale })
                              : '—',
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || t('documents.govEdms.noRequisites')}
                  </span>
                  <span className="text-2xs text-fg-muted">
                    {t(`documents.govEdms.prefill.${item.prefillStatus}`)} · {item.fileName ?? '—'}{' '}
                    · {formatDateTime(item.createdAt, { locale })}
                    {item.createdBy ? ` · ${item.createdBy.displayName}` : ''}
                  </span>
                  {item.duplicateOf ? (
                    <span className="flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="size-3.5" aria-hidden />
                      {t('documents.govEdms.duplicateNumber', {
                        title: item.duplicateOf.regNumber ?? item.duplicateOf.title,
                      })}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasNextPage ? (
          <div className="p-3">
            <Button
              size="sm"
              variant="ghost"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {t('common.actions.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
      {uploading ? <GovEdmsImportDialog onClose={() => setUploading(false)} /> : null}
    </section>
  )
}

interface PlannedDocument extends ImportDocument {
  duplicate: { title: string; regNumber: string | null } | null
}

/**
 * Загрузка выгрузки госЭДО: файлы → документы (ZIP — документ с приложениями) →
 * проверка повторов по SHA-256 → черновики по одному. Повторы не заводятся.
 */
export function GovEdmsImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [files, setFiles] = useState<File[]>([])
  const [mode, setMode] = useState<ImportMode>('separate')
  const [plan, setPlan] = useState<PlannedDocument[] | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [failures, setFailures] = useState<string[]>([])

  const loose = files.filter((file) => !isZip(file)).length

  const prepare = async (selected: File[], nextMode: ImportMode) => {
    setFiles(selected)
    setMode(nextMode)
    setPlan(null)
    setFailures([])
    if (selected.length === 0) return
    setPreparing(true)
    try {
      const documents = await planImport(selected, nextMode)
      const hashes = await Promise.all(documents.map((item) => sha256Hex(item.main)))
      const known = await duplicatesOf([...new Set(hashes)])
      setPlan(
        documents.map((item, index) => ({
          ...item,
          duplicate: known.get(hashes[index] ?? '') ?? null,
        })),
      )
    } catch (error) {
      toast.error(errorText(error, t('documents.govEdms.unreadable')))
    } finally {
      setPreparing(false)
    }
  }

  const fresh = plan?.filter((item) => !item.duplicate) ?? []

  const start = async () => {
    setProgress({ done: 0, total: fresh.length })
    const failed: string[] = []
    let created = 0
    for (const item of fresh) {
      try {
        await importDocument(item)
        created += 1
      } catch (error) {
        failed.push(`${item.name}: ${errorText(error, t('errors.unknown'))}`)
      }
      setProgress((current) => (current ? { ...current, done: current.done + 1 } : current))
    }
    setFailures(failed)
    void client.invalidateQueries({ queryKey: govEdmsKeys.all })
    toast.show({
      title: t('documents.govEdms.done', {
        created,
        skipped: (plan?.length ?? 0) - fresh.length,
      }),
      tone: failed.length > 0 ? 'warning' : 'success',
    })
    if (failed.length === 0) onClose()
    else setProgress(null)
  }

  const busy = progress !== null

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent
        title={t('documents.govEdms.uploadTitle')}
        description={t('documents.govEdms.uploadHint')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={fresh.length === 0 || preparing}
              loading={busy}
              onClick={() => void start()}
            >
              {t('documents.govEdms.start', { count: fresh.length })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <FileDropzone
            multiple
            accept=".pdf,.doc,.docx,.odt,.rtf,.zip,.tif,.tiff,.jpg,.jpeg,.png,.xlsx,.xls,.txt,.xml,.sig,.p7s"
            disabled={busy}
            label={t('documents.govEdms.pick')}
            hint={t('documents.govEdms.zipNote')}
            onFiles={(picked) => void prepare([...files, ...picked], mode)}
          />
          {loose > 1 ? (
            <SegmentedControl
              size="sm"
              aria-label={t('documents.govEdms.mode.label')}
              value={mode}
              onValueChange={(next) => void prepare(files, next as ImportMode)}
              options={[
                { value: 'separate', label: t('documents.govEdms.mode.separate') },
                { value: 'single', label: t('documents.govEdms.mode.single') },
              ]}
            />
          ) : null}
          {preparing ? <Skeleton className="h-16 w-full" /> : null}
          {plan && plan.length > 0 ? (
            <ul aria-label={t('documents.govEdms.planLabel')} className="flex flex-col gap-1.5">
              {plan.map((item) => (
                <li
                  key={`${item.name}:${item.main.name}`}
                  className="rounded-md border border-line px-3 py-2 text-sm"
                >
                  <span className="font-medium text-fg">{item.name}</span>
                  <span className="ml-2 text-xs text-fg-muted">
                    {t('documents.govEdms.planItem', {
                      main: item.main.name,
                      count: item.attachments.length,
                    })}
                  </span>
                  {item.duplicate ? (
                    <span className="mt-1 flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="size-3.5" aria-hidden />
                      {t('documents.govEdms.duplicate', {
                        title: item.duplicate.regNumber ?? item.duplicate.title,
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {progress ? (
            <ProgressBar
              value={progress.done}
              max={Math.max(progress.total, 1)}
              label={t('documents.govEdms.importing', progress)}
              showValue
            />
          ) : null}
          {failures.length > 0 ? (
            <Callout tone="danger" title={t('documents.govEdms.failedTitle')}>
              <ul className="list-disc pl-4">
                {failures.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
