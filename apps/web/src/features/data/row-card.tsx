import type {
  DatasetField,
  DatasetRecord,
  DatasetRow,
  DatasetRowHistoryEntry,
  FieldDef,
  Locale,
} from '@kchs/contracts'
import { formatDateTime, formatValue } from '@kchs/fields'
import {
  AlertDialog,
  Avatar,
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  InlineProperties,
  SchemaForm,
  Sheet,
  SheetContent,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { fieldLabel } from './field-types.js'
import { dataKeys, datasetRowQuery, rowHistoryQuery } from './queries.js'

interface ValueContext {
  locale: Locale
  timezone?: string
}

/** Поля, которые не правятся формой: геометрия — на карте (фаза 2). */
const FORM_EXCLUDED = new Set<string>(['geometry'])

/** Значение текстом: геометрия и JSON — кратко, остальное — по типу поля. */
function valueText(field: FieldDef, value: unknown, ctx: ValueContext): string {
  if (value === null || value === undefined || value === '') return '—'
  if (field.type === 'geometry' && typeof value === 'object') {
    const type = (value as { type?: unknown }).type
    return typeof type === 'string' ? `GeoJSON · ${type}` : 'GeoJSON'
  }
  if (typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value)
  return formatValue(value, field, ctx) || '—'
}

/** Заголовок строки: значения ключа или первое заполненное текстовое поле. */
function rowTitle(dataset: DatasetRecord, row: DatasetRow): string | null {
  const key = dataset.primaryKey
    .map((name) => row.values[name])
    .filter((value) => value !== null && value !== undefined && value !== '')
  if (key.length > 0) return key.map(String).join(' · ')
  const text = dataset.fields.find(
    (field) => (field.type === 'text' || field.type === 'identifier') && row.values[field.key],
  )
  return text ? String(row.values[text.key]) : null
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/**
 * Карточка строки датасета (P1-E03 S03): все поля с правкой по месту (версия
 * строки — защита от чужой правки), история изменений и удаление. Открывается
 * из таблицы: Enter, двойной щелчок или номер строки.
 */
export function RowCard({
  dataset,
  rowId,
  canEdit,
  onClose,
  onChanged,
}: {
  dataset: DatasetRecord
  rowId: string
  canEdit: boolean
  onClose: () => void
  /** Строка изменилась или удалена — таблица перечитывает данные. */
  onChanged: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { data: me } = useQuery(meQuery())
  const { data: row, error, isLoading, refetch } = useQuery(datasetRowQuery(dataset.id, rowId))
  const [removing, setRemoving] = useState(false)
  const ctx: ValueContext = { locale, ...(me?.user.timezone ? { timezone: me.user.timezone } : {}) }
  const editable = canEdit && dataset.settings.editable

  const commit = async (key: string, value: unknown) => {
    if (!row) return
    try {
      const next = await http.patch<DatasetRow>(`/datasets/${dataset.id}/rows/${rowId}`, {
        values: { [key]: value },
        ver: row._ver,
      })
      client.setQueryData(dataKeys.row(dataset.id, rowId), next)
      void client.invalidateQueries({ queryKey: dataKeys.rowHistory(dataset.id, rowId) })
      onChanged()
    } catch (failure) {
      // Конфликт версии: показываем текущие значения, правку можно повторить
      if (failure instanceof ApiError && failure.status === 409) {
        toast.error(t('data.row.conflict'))
        void refetch()
        return
      }
      toast.error(errorText(failure, t('errors.unknown')))
    }
  }

  const remove = useMutation({
    mutationFn: () => http.post(`/datasets/${dataset.id}/rows/delete`, { ids: [rowId] }),
    onSuccess: () => {
      toast.show({ title: t('data.row.removed'), tone: 'success' })
      onChanged()
      onClose()
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
  })

  const title = row ? (rowTitle(dataset, row) ?? t('data.row.title', { id: rowId })) : ''
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        title={title || t('data.row.title', { id: rowId })}
        description={row ? t('data.row.subtitle', { id: rowId, ver: row._ver }) : undefined}
        width="min(560px, 100vw)"
        footer={
          editable && row ? (
            <Button
              variant="ghost"
              icon={<Trash2 className="size-4" />}
              onClick={() => setRemoving(true)}
            >
              {t('data.row.remove')}
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <ErrorState
            description={errorText(error, t('errors.unknown'))}
            onRetry={() => void refetch()}
          />
        ) : isLoading || !row ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-6 w-3/5" />
          </div>
        ) : (
          <Tabs defaultValue="fields" className="flex flex-col gap-3">
            <TabsList>
              <TabsTrigger value="fields">{t('data.row.tabs.fields')}</TabsTrigger>
              <TabsTrigger value="history">{t('data.row.tabs.history')}</TabsTrigger>
            </TabsList>
            <TabsContent value="fields">
              <InlineProperties
                schema={{ fields: dataset.fields }}
                values={row.values}
                onCommit={commit}
                renderValue={(field, value) => valueText(field, value, ctx)}
                readOnly={!editable}
              />
            </TabsContent>
            <TabsContent value="history">
              <RowHistory dataset={dataset} rowId={rowId} ctx={ctx} />
            </TabsContent>
          </Tabs>
        )}
        <AlertDialog
          open={removing}
          onOpenChange={setRemoving}
          title={t('data.row.removeTitle')}
          description={t('data.row.removeBody')}
          confirmLabel={t('common.actions.delete')}
          destructive
          loading={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </SheetContent>
    </Sheet>
  )
}

function RowHistory({
  dataset,
  rowId,
  ctx,
}: {
  dataset: DatasetRecord
  rowId: string
  ctx: ValueContext
}) {
  const t = useT()
  const { data: entries, error, isLoading } = useQuery(rowHistoryQuery(dataset.id, rowId))
  const byKey = new Map(dataset.fields.map((field) => [field.key, field]))

  if (error) {
    return (
      <Callout tone={error instanceof ApiError && error.status === 403 ? 'info' : 'danger'}>
        {errorText(error, t('errors.unknown'))}
      </Callout>
    )
  }
  if (isLoading || !entries) return <Skeleton className="h-16 w-full" />
  if (entries.length === 0) {
    return (
      <EmptyState
        compact
        icon={<History />}
        title={t('data.row.historyEmpty')}
        description={dataset.settings.trackHistory ? undefined : t('data.row.historyOff')}
      />
    )
  }
  return (
    <ol className="flex flex-col gap-2">
      {entries.map((entry) => (
        <HistoryItem key={entry.id} entry={entry} byKey={byKey} ctx={ctx} />
      ))}
    </ol>
  )
}

function HistoryItem({
  entry,
  byKey,
  ctx,
}: {
  entry: DatasetRowHistoryEntry
  byKey: Map<string, DatasetField>
  ctx: ValueContext
}) {
  const t = useT()
  const who = entry.changedBy?.displayName ?? t('data.row.system')
  const keys = Object.keys(entry.values).filter((key) => byKey.has(key))
  return (
    <li className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
        <Avatar name={who} src={entry.changedBy?.avatarUrl ?? null} size="xs" />
        <span className="text-fg">{who}</span>
        <time dateTime={entry.changedAt}>{formatDateTime(entry.changedAt, ctx)}</time>
        <Badge size="sm" tone={entry.op === 'delete' ? 'danger' : 'neutral'}>
          {t(`data.row.ops.${entry.op}`)}
        </Badge>
        <span className="ml-auto tabular text-fg-muted">
          {t('data.row.version', { ver: entry.ver })}
        </span>
      </div>
      {keys.length > 0 && entry.op !== 'delete' ? (
        <dl className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-sm">
          {keys.map((key) => {
            const field = byKey.get(key) as DatasetField
            const previous = entry.previous?.[key]
            return (
              <div key={key} className="contents">
                <dt className="truncate text-fg-secondary">{fieldLabel(field, ctx.locale)}</dt>
                <dd className="min-w-0 break-words">
                  {entry.op === 'update' ? (
                    <span className="text-fg-muted line-through">
                      {valueText(field, previous, ctx)}
                    </span>
                  ) : null}
                  {entry.op === 'update' ? ' → ' : null}
                  <span>{valueText(field, entry.values[key], ctx)}</span>
                </dd>
              </div>
            )
          })}
        </dl>
      ) : null}
    </li>
  )
}

/** Новая строка формой по схеме датасета (кнопка «Строка» над таблицей). */
export function NewRowDialog({
  dataset,
  onClose,
  onCreated,
}: {
  dataset: DatasetRecord
  onClose: () => void
  onCreated: (rowId: string | null) => void
}) {
  const t = useT()
  const toast = useToast()
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const fields = dataset.fields.filter((field) => !field.readOnly && !FORM_EXCLUDED.has(field.type))

  const submit = async (submitted: Record<string, unknown>) => {
    try {
      const { items } = await http.post<{ items: DatasetRow[] }>(`/datasets/${dataset.id}/rows`, {
        rows: [{ values: submitted }],
      })
      toast.show({ title: t('data.row.created'), tone: 'success' })
      onCreated(items[0]?._id ?? null)
    } catch (error) {
      setServerErrors(error instanceof ApiError ? error.fieldErrors() : {})
      setFailure(errorText(error, t('errors.unknown')))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={t('data.row.newTitle')} size="md">
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <SchemaForm
            schema={{ fields }}
            values={values}
            onChange={setValues}
            onSubmit={submit}
            serverErrors={serverErrors}
            submitLabel={t('common.actions.create')}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
