import type {
  CaseRecord,
  CaseStatus,
  DestructionActRecord,
  DocumentStatus,
  ObjectSummary,
} from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Button,
  Callout,
  Checkbox,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  KeyValueList,
  PanelToolbar,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Switch,
  Textarea,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Briefcase,
  FileX,
  Lock,
  LockOpen,
  MoreHorizontal,
  Plus,
  Share2,
  X,
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { http } from '~/shared/api/client.js'
import { meQuery, objectListQuery, orgUnitsQuery } from '~/shared/api/queries.js'
import { PrintMenu } from '../print/print-menu.js'
import {
  caseQuery,
  casesQuery,
  destructionActsQuery,
  documentKeys,
  documentTypesQuery,
} from '../queries.js'
import { DOCUMENT_STATUS_TONE, errorText, localToday } from '../status.js'

/** Цвет состояния дела — ключ `STATUS_TONES` дизайн-системы. */
const CASE_STATUS_TONE: Record<CaseStatus, string> = {
  open: 'in_progress',
  closed: 'done',
  archived: 'cancelled',
  destroyed: 'rejected',
}

const ALL = 'all'

/**
 * Перечитать дела после изменения: незавершённый запрос списка отменяется —
 * иначе первый запрос, начатый до изменения, вернул бы устаревший список, а
 * повторного не было бы (у списка ещё нет данных — TanStack Query ждёт его).
 */
async function refreshCases(client: QueryClient, id?: string): Promise<void> {
  await client.cancelQueries({ queryKey: [...documentKeys.all, 'cases'] })
  await client.invalidateQueries({ queryKey: documentKeys.all })
  if (id) await client.invalidateQueries({ queryKey: ['object', id] })
}

/** Дело можно выделить к уничтожению: в архиве и срок хранения истёк. */
export function destroyable(record: CaseRecord, today: string): boolean {
  return (
    record.status === 'archived' &&
    record.destroyableFrom !== null &&
    record.destroyableFrom <= today
  )
}

/**
 * Номенклатура дел (08-documents.md §12, ADR-0086): дела по годам с индексом,
 * сроком хранения и числом документов; закрытие дел года, передача в архив,
 * акт о выделении к уничтожению. Ведут номенклатуру владельцы способности
 * «вести журналы»; подшивают документы делопроизводители — права дела.
 */
export function CasesDirectory({ selectedId }: { selectedId: string | null }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { data: me } = useQuery(meQuery())
  const today = localToday()
  const currentYear = Number(today.slice(0, 4))
  const { data: opened } = useQuery({
    ...caseQuery(selectedId ?? ''),
    enabled: Boolean(selectedId),
  })
  const [year, setYear] = useState<string>(String(currentYear))
  const [status, setStatus] = useState<string>(ALL)
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 250)
  const [selected, setSelected] = useState<string | null>(selectedId)
  const [creating, setCreating] = useState(false)
  const [closingYear, setClosingYear] = useState(false)
  const [destroying, setDestroying] = useState(false)
  const canManage = me?.capabilities.includes('documents.journals.manage') ?? false

  // Открытое из ссылки дело другого года — список переключается на его год
  useEffect(() => {
    if (opened) setYear(String(opened.year))
  }, [opened])

  const { data: items = [], isLoading } = useQuery(
    casesQuery({
      ...(year !== ALL ? { year: Number(year) } : {}),
      ...(status !== ALL ? { status: status as CaseStatus } : {}),
      ...(q ? { q } : {}),
    }),
  )
  const listed = items.find((item) => item.id === selected)
  const { data: fetched } = useQuery({
    ...caseQuery(selected ?? ''),
    enabled: Boolean(selected) && !isLoading && !listed,
  })
  const current = listed ?? (fetched?.id === selected ? fetched : null)
  const years = [currentYear + 1, currentYear, currentYear - 1, currentYear - 2, currentYear - 5]

  const closeYear = useMutation({
    mutationFn: () => http.post<{ closed: number }>('/cases/close-year', { year: Number(year) }),
    onSuccess: async ({ closed }) => {
      toast.show({ title: t('documents.cases.closeYear.done', { count: closed }), tone: 'success' })
      setClosingYear(false)
      await refreshCases(client)
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  // Ключевые столбцы — слева: в узкой области рядом с панелью дела таблица прокручивается вбок
  const columns: Array<DataTableColumn<CaseRecord>> = [
    {
      key: 'index',
      header: t('documents.cases.fields.index'),
      width: 100,
      cell: (item) => <span className="font-mono text-xs tabular">{item.index}</span>,
    },
    {
      key: 'title',
      header: t('documents.cases.fields.title'),
      minWidth: 200,
      cell: (item) => <span className="truncate">{item.title}</span>,
    },
    {
      key: 'status',
      header: t('documents.cases.fields.status'),
      width: 120,
      cell: (item) => (
        <StatusBadge
          status={CASE_STATUS_TONE[item.status]}
          label={t(`documents.cases.statuses.${item.status}`)}
        />
      ),
    },
    {
      key: 'documents',
      header: t('documents.cases.fields.documents'),
      width: 100,
      align: 'end',
      cell: (item) => <span className="tabular">{item.documentCount}</span>,
    },
    {
      key: 'year',
      header: t('documents.cases.fields.year'),
      width: 72,
      cell: (item) => <span className="tabular">{item.year}</span>,
    },
    {
      key: 'retention',
      header: t('documents.cases.fields.retention'),
      width: 120,
      cell: (item) => <RetentionText record={item} />,
    },
    {
      key: 'unit',
      header: t('documents.fields.unit'),
      width: 160,
      cell: (item) => item.unit?.name ?? <span className="text-fg-muted">—</span>,
    },
  ]

  return (
    <section aria-label={t('documents.cases.title')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('documents.cases.title')}</h1>}
        right={
          canManage ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" icon={<MoreHorizontal className="size-3.5" />}>
                    {t('documents.cases.more')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {year !== ALL ? (
                    <DropdownMenuItem
                      icon={<Lock className="size-3.5" />}
                      onSelect={() => setClosingYear(true)}
                    >
                      {t('documents.cases.closeYear.action', { year })}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    icon={<FileX className="size-3.5" />}
                    danger
                    onSelect={() => setDestroying(true)}
                  >
                    {t('documents.cases.destruction.open')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="size-3.5" />}
                onClick={() => setCreating(true)}
              >
                {t('documents.cases.create')}
              </Button>
            </>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger aria-label={t('documents.cases.fields.year')} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('documents.cases.allYears')}</SelectItem>
            {years.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label={t('documents.cases.fields.status')} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('documents.cases.allStatuses')}</SelectItem>
            {(['open', 'closed', 'archived', 'destroyed'] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {t(`documents.cases.statuses.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('documents.cases.search')}
          className="w-56"
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="min-h-0">
          {!isLoading && items.length === 0 ? (
            <EmptyState
              icon={<Briefcase />}
              title={t('documents.cases.empty')}
              description={t('documents.cases.emptyHint')}
            />
          ) : (
            <DataTable
              aria-label={t('documents.cases.title')}
              rows={items}
              getRowId={(item) => item.id}
              columns={columns}
              loading={isLoading}
              revealId={selected}
              onRowClick={(item) => setSelected(item.id)}
              onRowOpen={(item) => setSelected(item.id)}
            />
          )}
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface-2">
          {current ? (
            <CasePanel key={current.id} record={current} onClose={() => setSelected(null)} />
          ) : (
            <EmptyState compact icon={<Briefcase />} title={t('documents.cases.pick')} />
          )}
        </aside>
      </div>
      {creating ? (
        <CreateCaseDialog
          year={year === ALL ? currentYear : Number(year)}
          onClose={() => setCreating(false)}
          onCreated={setSelected}
        />
      ) : null}
      {destroying ? <DestructionDialog onClose={() => setDestroying(false)} /> : null}
      <AlertDialog
        open={closingYear}
        onOpenChange={setClosingYear}
        title={t('documents.cases.closeYear.title', { year })}
        description={t('documents.cases.closeYear.hint')}
        confirmLabel={t('documents.cases.closeYear.confirm')}
        loading={closeYear.isPending}
        onConfirm={() => closeYear.mutate()}
      />
    </section>
  )
}

function RetentionText({ record }: { record: CaseRecord }) {
  const t = useT()
  return (
    <span className="text-fg-secondary">
      {record.retentionYears === null
        ? t('documents.cases.permanent')
        : t('documents.cases.years', { count: record.retentionYears })}
    </span>
  )
}

function CasePanel({ record, onClose }: { record: CaseRecord; onClose: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [title, setTitle] = useState(record.title)
  const [note, setNote] = useState(record.note ?? '')
  const [shareOpen, setShareOpen] = useState(false)
  const [confirm, setConfirm] = useState<'close' | 'reopen' | 'archive' | null>(null)
  const editable = record.canManage && record.status !== 'destroyed'
  const dirty = title.trim() !== record.title || note.trim() !== (record.note ?? '')

  const refresh = () => refreshCases(client, record.id)
  const save = useMutation({
    mutationFn: () =>
      http.patch<CaseRecord>(`/cases/${record.id}`, {
        title: title.trim(),
        note: note.trim() || null,
      }),
    onSuccess: async () => {
      toast.show({ title: t('documents.cases.saved'), tone: 'success' })
      await refresh()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })
  const act = useMutation({
    mutationFn: (action: 'close' | 'reopen' | 'archive') =>
      http.post<CaseRecord>(`/cases/${record.id}/${action}`, {}),
    onSuccess: async (_result, action) => {
      toast.show({ title: t(`documents.cases.done.${action}`), tone: 'success' })
      setConfirm(null)
      await refresh()
      await client.invalidateQueries({ queryKey: ['objects'] })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const person = (value: { displayName: string } | null, at: string | null) =>
    at ? `${value?.displayName ?? '—'} · ${formatDateTime(at, { locale })}` : '—'

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-xs tabular text-fg-secondary">{record.index}</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={record.title}>
          {record.title}
        </h2>
        <PrintMenu subjectId={record.id} />
        {record.canManage ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Share2 className="size-3.5" />}
            onClick={() => setShareOpen(true)}
          >
            {t('documents.cases.registrars')}
          </Button>
        ) : null}
        <IconButton size="sm" label={t('common.actions.close')} onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <KeyValueList
        columns={2}
        items={[
          {
            key: 'status',
            label: t('documents.cases.fields.status'),
            value: (
              <StatusBadge
                status={CASE_STATUS_TONE[record.status]}
                label={t(`documents.cases.statuses.${record.status}`)}
              />
            ),
          },
          { key: 'year', label: t('documents.cases.fields.year'), value: String(record.year) },
          { key: 'unit', label: t('documents.fields.unit'), value: record.unit?.name ?? '—' },
          {
            key: 'retention',
            label: t('documents.cases.fields.retention'),
            value: <RetentionText record={record} />,
          },
          {
            key: 'destroyable',
            label: t('documents.cases.fields.destroyableFrom'),
            value: record.destroyableFrom
              ? formatDate(record.destroyableFrom, { locale })
              : t('documents.cases.never'),
          },
          {
            key: 'documents',
            label: t('documents.cases.fields.documents'),
            value: String(record.documentCount),
          },
          {
            key: 'closed',
            label: t('documents.cases.fields.closed'),
            value: person(record.closedBy, record.closedAt),
          },
          {
            key: 'archived',
            label: t('documents.cases.fields.archived'),
            value: person(record.archivedBy, record.archivedAt),
          },
        ]}
      />
      {record.retentionNote ? (
        <p className="text-xs text-fg-muted">{record.retentionNote}</p>
      ) : null}
      {record.destructionAct ? (
        <Callout tone="warning" title={t('documents.cases.destroyed')}>
          {t('documents.cases.destroyedHint', {
            number: record.destructionAct.number,
            date: formatDate(record.destructionAct.actDate, { locale }),
          })}
        </Callout>
      ) : null}

      {record.canManage ? (
        <div className="flex flex-wrap gap-2">
          {record.status === 'open' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Lock className="size-3.5" />}
              onClick={() => setConfirm('close')}
            >
              {t('documents.cases.actions.close')}
            </Button>
          ) : null}
          {record.status === 'closed' ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<Archive className="size-3.5" />}
                onClick={() => setConfirm('archive')}
              >
                {t('documents.cases.actions.archive')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<LockOpen className="size-3.5" />}
                onClick={() => setConfirm('reopen')}
              >
                {t('documents.cases.actions.reopen')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <Field label={t('documents.cases.fields.title')} htmlFor={`${formId}-title`}>
            <Input
              id={`${formId}-title`}
              value={title}
              maxLength={500}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={t('documents.cases.fields.note')} htmlFor={`${formId}-note`}>
            <Textarea
              id={`${formId}-note`}
              value={note}
              rows={2}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || !title.trim()}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('common.actions.save')}
          </Button>
        </div>
      ) : null}

      <CaseDocuments record={record} />
      <ShareDialog
        objectId={record.id}
        title={`${record.index} · ${record.title}`}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? t(`documents.cases.confirm.${confirm}.title`) : ''}
        description={
          confirm
            ? t(`documents.cases.confirm.${confirm}.hint`, { count: record.documentCount })
            : undefined
        }
        confirmLabel={confirm ? t(`documents.cases.actions.${confirm}`) : undefined}
        loading={act.isPending}
        onConfirm={() => {
          if (confirm) act.mutate(confirm)
        }}
      />
    </div>
  )
}

/** Документы дела — видимые пользователю, в порядке подшивки (опись). */
function CaseDocuments({ record }: { record: CaseRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(
    objectListQuery({
      types: 'document',
      filter: JSON.stringify({ field: 'caseId', op: 'in', value: [record.id] }),
      sort: 'regDate:asc',
      limit: 200,
    }),
  )
  const documents = data?.items ?? []
  const meta = (item: ObjectSummary) => item.meta as Record<string, unknown>
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.cases.inventory')}
      </h3>
      {isLoading ? null : documents.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('documents.cases.noDocuments')}</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {documents.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-surface-3"
                onClick={() =>
                  openTab({
                    kind: 'object',
                    objectId: item.id,
                    objectType: 'document',
                    title: item.subtitle ? `${item.subtitle} · ${item.title}` : item.title,
                    mode: 'permanent',
                  })
                }
              >
                <span className="w-6 shrink-0 tabular text-fg-muted">{index + 1}</span>
                <span className="w-28 shrink-0 font-mono tabular text-fg-secondary">
                  {String(meta(item).regNumber ?? '—')}
                </span>
                <span className="w-20 shrink-0 tabular text-fg-muted">
                  {typeof meta(item).regDate === 'string'
                    ? formatDate(String(meta(item).regDate), { locale })
                    : '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
                <StatusBadge
                  status={DOCUMENT_STATUS_TONE[meta(item).status as DocumentStatus] ?? 'draft'}
                  label={t(`documents.statuses.${String(meta(item).status)}`)}
                />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function CreateCaseDialog({
  year,
  onClose,
  onCreated,
}: {
  year: number
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const formId = useId()
  const { data: units = [] } = useQuery(orgUnitsQuery())
  const { data: types = [] } = useQuery(documentTypesQuery())
  const [index, setIndex] = useState('')
  const [title, setTitle] = useState('')
  const [caseYear, setCaseYear] = useState(String(year))
  const [unitId, setUnitId] = useState<string>('')
  const [permanent, setPermanent] = useState(false)
  const [retention, setRetention] = useState('5')
  const [typeIds, setTypeIds] = useState<string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const retentionYears = Number(retention)
  const valid =
    index.trim() &&
    title.trim() &&
    /^\d{4}$/.test(caseYear) &&
    (permanent || (Number.isInteger(retentionYears) && retentionYears >= 1))

  const create = useMutation({
    mutationFn: () =>
      http.post<CaseRecord>('/cases', {
        index: index.trim(),
        title: title.trim(),
        year: Number(caseYear),
        unitId: unitId || null,
        retentionYears: permanent ? null : retentionYears,
        documentTypeIds: typeIds,
      }),
    onSuccess: async (record) => {
      await refreshCases(client)
      onCreated(record.id)
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.cases.create')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <div className="grid grid-cols-[120px_1fr_100px] gap-3">
            <Field label={t('documents.cases.fields.index')} htmlFor={`${formId}-index`} required>
              <Input
                id={`${formId}-index`}
                autoFocus
                value={index}
                maxLength={40}
                className="font-mono"
                onChange={(event) => setIndex(event.target.value)}
              />
            </Field>
            <Field label={t('documents.cases.fields.title')} htmlFor={`${formId}-title`} required>
              <Input
                id={`${formId}-title`}
                value={title}
                maxLength={500}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label={t('documents.cases.fields.year')} htmlFor={`${formId}-year`} required>
              <Input
                id={`${formId}-year`}
                value={caseYear}
                inputMode="numeric"
                maxLength={4}
                onChange={(event) => setCaseYear(event.target.value)}
              />
            </Field>
          </div>
          <Field label={t('documents.fields.unit')}>
            <Select value={unitId} onValueChange={setUnitId}>
              <SelectTrigger aria-label={t('documents.fields.unit')}>
                <SelectValue placeholder={t('documents.placeholders.choose')} />
              </SelectTrigger>
              <SelectContent>
                {units.map((unit) => (
                  <SelectItem key={unit.id} value={unit.id}>
                    {(unit.name as Record<string, string | undefined>)[locale] ?? unit.name.ru}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-end gap-3">
            <Field
              label={t('documents.cases.fields.retention')}
              htmlFor={`${formId}-retention`}
              hint={t('documents.cases.retentionHint')}
            >
              <Input
                id={`${formId}-retention`}
                type="number"
                min={1}
                max={100}
                value={retention}
                disabled={permanent}
                className="w-24"
                onChange={(event) => setRetention(event.target.value)}
              />
            </Field>
            <Switch
              label={t('documents.cases.permanent')}
              checked={permanent}
              onCheckedChange={setPermanent}
            />
          </div>
          <Field label={t('documents.cases.fields.types')} hint={t('documents.cases.typesHint')}>
            <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto rounded-md border border-line p-2">
              {types.map((type) => (
                <Checkbox
                  key={type.id}
                  label={type.name[locale] ?? type.name.ru}
                  checked={typeIds.includes(type.id)}
                  onCheckedChange={(checked) =>
                    setTypeIds((current) =>
                      checked === true
                        ? [...current, type.id]
                        : current.filter((id) => id !== type.id),
                    )
                  }
                />
              ))}
            </div>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Акт о выделении к уничтожению (08-documents.md §12): дела в архиве с
 * истёкшим сроком хранения; файлы документов удаляются безвозвратно, карточки
 * остаются описью. Действие необратимо — подтверждение и основание обязательны.
 */
function DestructionDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const basisId = useId()
  const today = localToday()
  const { data: archived = [] } = useQuery(casesQuery({ status: 'archived' }))
  const { data: acts = [] } = useQuery(destructionActsQuery())
  const eligible = archived.filter((record) => destroyable(record, today))
  const [chosen, setChosen] = useState<string[]>([])
  const [basis, setBasis] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const destroy = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/cases/destruction-acts', {
        caseIds: chosen,
        basis: basis.trim(),
      }),
    onSuccess: async () => {
      toast.show({ title: t('documents.cases.destruction.done'), tone: 'success' })
      setConfirming(false)
      setChosen([])
      setBasis('')
      await refreshCases(client)
    },
    onError: (error) => {
      setConfirming(false)
      setFailure(errorText(error, t('errors.unknown')))
    },
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.cases.destruction.title')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.close')}
            </Button>
            <Button
              variant="danger"
              disabled={chosen.length === 0 || basis.trim().length < 10}
              onClick={() => setConfirming(true)}
            >
              {t('documents.cases.destruction.submit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-secondary">{t('documents.cases.destruction.hint')}</p>
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          {eligible.length === 0 ? (
            <p className="text-xs text-fg-muted">{t('documents.cases.destruction.none')}</p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
              {eligible.map((record) => (
                <li key={record.id}>
                  <Checkbox
                    label={t('documents.cases.destruction.item', {
                      index: record.index,
                      title: record.title,
                      year: record.year,
                      count: record.documentCount,
                    })}
                    checked={chosen.includes(record.id)}
                    onCheckedChange={(checked) =>
                      setChosen((current) =>
                        checked === true
                          ? [...current, record.id]
                          : current.filter((id) => id !== record.id),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          <Field
            label={t('documents.cases.destruction.basis')}
            htmlFor={basisId}
            hint={t('documents.cases.destruction.basisHint')}
            required
          >
            <Textarea
              id={basisId}
              value={basis}
              rows={2}
              maxLength={2000}
              onChange={(event) => setBasis(event.target.value)}
            />
          </Field>
          {acts.length > 0 ? <ActsList acts={acts} /> : null}
        </div>
        <AlertDialog
          open={confirming}
          onOpenChange={setConfirming}
          destructive
          title={t('documents.cases.destruction.confirmTitle')}
          description={t('documents.cases.destruction.confirmHint', { count: chosen.length })}
          confirmLabel={t('documents.cases.destruction.submit')}
          loading={destroy.isPending}
          onConfirm={() => destroy.mutate()}
        />
      </DialogContent>
    </Dialog>
  )
}

function ActsList({ acts }: { acts: DestructionActRecord[] }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (
    <section className="flex flex-col gap-1.5 border-t border-line pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.cases.destruction.history')}
      </h3>
      <ul className="flex flex-col gap-1 text-xs">
        {acts.map((act) => (
          <li key={act.id} className="flex gap-2">
            <span className="shrink-0 font-mono tabular text-fg">
              {t('documents.cases.destruction.act', { number: act.number })}
            </span>
            <span className="shrink-0 tabular text-fg-muted">
              {formatDate(act.actDate, { locale })}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg-secondary" title={act.basis}>
              {act.cases.map((item) => `${item.index} (${item.year})`).join(', ')} ·{' '}
              {t('documents.cases.destruction.counts', {
                documents: act.documentCount,
                files: act.fileCount,
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
