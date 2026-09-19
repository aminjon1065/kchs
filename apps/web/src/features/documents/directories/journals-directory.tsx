import {
  DEFAULT_NUMBER_FORMAT,
  formatRegNumber,
  type JournalRecord,
  type JournalReservation,
  numberFormatIssue,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  Input,
  PanelToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Plus, Share2, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { documentKeys, journalReservationsQuery, journalsQuery } from '../queries.js'
import { errorText, localToday } from '../status.js'

/**
 * Справочник журналов регистрации (08-documents.md §5): шаблон номера с
 * предпросмотром, сброс счётчика, резерв номеров для бумажных документов.
 * Делопроизводители журнала — его права («Поделиться»): документы журнала
 * видны им по наследованию. Ведут журналы владельцы `documents.journals.manage`.
 */
export function JournalsDirectory({ selectedId }: { selectedId: string | null }) {
  const t = useT()
  const { data: me } = useQuery(meQuery())
  const { data: journals = [], isLoading } = useQuery(journalsQuery(true))
  const [selected, setSelected] = useState<string | null>(selectedId)
  const [creating, setCreating] = useState(false)
  const current = journals.find((journal) => journal.id === selected) ?? null
  const canCreate = me?.capabilities.includes('documents.journals.manage') ?? false

  const columns: Array<DataTableColumn<JournalRecord>> = [
    {
      key: 'name',
      header: t('documents.journals.name'),
      minWidth: 200,
      cell: (journal) => (
        <span className="flex items-center gap-2">
          <span className="truncate">{journal.name}</span>
          {journal.isActive ? null : <Badge size="sm">{t('documents.journals.closed')}</Badge>}
        </span>
      ),
    },
    {
      key: 'format',
      header: t('documents.journals.format'),
      width: 190,
      cell: (journal) => <span className="font-mono text-xs">{journal.format}</span>,
    },
    {
      key: 'next',
      header: t('documents.journals.nextNumber'),
      width: 140,
      cell: (journal) => <span className="font-mono text-xs tabular">{journal.nextNumber}</span>,
    },
    {
      key: 'unit',
      header: t('documents.fields.unit'),
      width: 160,
      cell: (journal) => journal.unit?.name ?? <span className="text-fg-muted">—</span>,
    },
    {
      key: 'documents',
      header: t('documents.journals.documents'),
      width: 110,
      cell: (journal) => <span className="tabular">{journal.documentCount}</span>,
    },
  ]

  return (
    <section aria-label={t('documents.journals.title')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('documents.journals.title')}</h1>}
        right={
          canCreate ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setCreating(true)}
            >
              {t('documents.journals.create')}
            </Button>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-h-0">
          {!isLoading && journals.length === 0 ? (
            <EmptyState
              icon={<BookOpen />}
              title={t('documents.journals.empty')}
              description={t('documents.journals.emptyHint')}
            />
          ) : (
            <DataTable
              aria-label={t('documents.journals.title')}
              rows={journals}
              getRowId={(journal) => journal.id}
              columns={columns}
              loading={isLoading}
              onRowClick={(journal) => setSelected(journal.id)}
              onRowOpen={(journal) => setSelected(journal.id)}
            />
          )}
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface-2">
          {current ? (
            <JournalPanel key={current.id} journal={current} onClose={() => setSelected(null)} />
          ) : (
            <EmptyState compact icon={<BookOpen />} title={t('documents.journals.pick')} />
          )}
        </aside>
      </div>
      {creating ? (
        <CreateJournalDialog onClose={() => setCreating(false)} onCreated={setSelected} />
      ) : null}
    </section>
  )
}

function FormatPreview({ prefix, format }: { prefix: string; format: string }) {
  const t = useT()
  const issue = numberFormatIssue(format)
  if (issue)
    return <p className="text-xs text-danger">{t(`documents.journals.formatIssues.${issue}`)}</p>
  const today = localToday()
  return (
    <p className="text-xs text-fg-muted">
      {t('documents.journals.preview', {
        number: formatRegNumber(format, { prefix, sequence: 1, date: today, unitCode: '01' }),
      })}
    </p>
  )
}

function JournalPanel({ journal, onClose }: { journal: JournalRecord; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [name, setName] = useState(journal.name)
  const [prefix, setPrefix] = useState(journal.prefix)
  const [format, setFormat] = useState(journal.format)
  const [reset, setReset] = useState(journal.reset)
  const [active, setActive] = useState(journal.isActive)
  const [shareOpen, setShareOpen] = useState(false)
  const dirty =
    name !== journal.name ||
    prefix !== journal.prefix ||
    format !== journal.format ||
    reset !== journal.reset ||
    active !== journal.isActive

  const save = useMutation({
    mutationFn: () =>
      http.patch<JournalRecord>(`/journals/${journal.id}`, {
        name: name.trim(),
        prefix: prefix.trim(),
        format,
        reset,
        isActive: active,
      }),
    onSuccess: () => {
      toast.show({ title: t('documents.journals.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: documentKeys.all })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{journal.name}</h2>
        {journal.canManage ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Share2 className="size-3.5" />}
            onClick={() => setShareOpen(true)}
          >
            {t('documents.journals.registrars')}
          </Button>
        ) : null}
        <IconButton size="sm" label={t('common.actions.close')} onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <p className="text-xs text-fg-muted">{t('documents.journals.registrarsHint')}</p>
      <Field label={t('documents.journals.name')} htmlFor={`${formId}-name`}>
        <Input
          id={`${formId}-name`}
          value={name}
          disabled={!journal.canManage}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('documents.journals.prefix')} htmlFor={`${formId}-prefix`}>
          <Input
            id={`${formId}-prefix`}
            value={prefix}
            maxLength={32}
            disabled={!journal.canManage}
            onChange={(event) => setPrefix(event.target.value)}
          />
        </Field>
        <Field label={t('documents.journals.reset')}>
          <Select
            value={reset}
            onValueChange={(next) => setReset(next as JournalRecord['reset'])}
            disabled={!journal.canManage}
          >
            <SelectTrigger aria-label={t('documents.journals.reset')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="year">{t('documents.journals.resets.year')}</SelectItem>
              <SelectItem value="never">{t('documents.journals.resets.never')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        label={t('documents.journals.format')}
        htmlFor={`${formId}-format`}
        hint={t('documents.journals.formatHint')}
      >
        <Input
          id={`${formId}-format`}
          value={format}
          maxLength={64}
          className="font-mono"
          disabled={!journal.canManage}
          onChange={(event) => setFormat(event.target.value)}
        />
      </Field>
      <FormatPreview prefix={prefix} format={format} />
      <Switch
        label={t('documents.journals.active')}
        checked={active}
        disabled={!journal.canManage}
        onCheckedChange={setActive}
      />
      {journal.canManage ? (
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || numberFormatIssue(format) !== null || !name.trim()}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('common.actions.save')}
        </Button>
      ) : null}
      <Reservations journal={journal} />
      <ShareDialog
        objectId={journal.id}
        title={journal.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </div>
  )
}

function Reservations({ journal }: { journal: JournalRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const { data: reservations = [] } = useQuery(journalReservationsQuery(journal.id))
  const [count, setCount] = useState('1')
  const [note, setNote] = useState('')
  const open = reservations.filter((reservation) => reservation.state === 'open')

  const refresh = () => {
    void client.invalidateQueries({ queryKey: documentKeys.reservations(journal.id) })
    void client.invalidateQueries({ queryKey: documentKeys.all })
  }
  const reserve = useMutation({
    mutationFn: () =>
      http.post<{ items: JournalReservation[] }>(`/journals/${journal.id}/reservations`, {
        count: Number(count),
        note: note.trim(),
      }),
    onSuccess: ({ items }) => {
      setNote('')
      toast.show({
        title: t('documents.reservations.done', {
          first: items[0]?.number ?? '',
          last: items[items.length - 1]?.number ?? '',
        }),
        tone: 'success',
      })
      refresh()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => http.delete(`/journals/${journal.id}/reservations/${id}`),
    onSuccess: refresh,
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.reservations.title')}
      </h3>
      {open.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('documents.reservations.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {open.map((reservation) => (
            <li key={reservation.id} className="flex items-center gap-2 text-xs">
              <span className="font-mono tabular text-fg">{reservation.number}</span>
              <span className="min-w-0 flex-1 truncate text-fg-muted" title={reservation.note}>
                {reservation.note} · {formatDateTime(reservation.reservedAt, { locale })}
              </span>
              {journal.canRegister ? (
                <IconButton
                  size="sm"
                  label={t('documents.reservations.cancel')}
                  onClick={() => cancel.mutate(reservation.id)}
                >
                  <X className="size-3.5" />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {journal.canRegister && journal.isActive ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <Field label={t('documents.reservations.count')} htmlFor={`${formId}-count`}>
              <Input
                id={`${formId}-count`}
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(event) => setCount(event.target.value)}
              />
            </Field>
            <Field label={t('documents.reservations.note')} htmlFor={`${formId}-note`}>
              <Input
                id={`${formId}-note`}
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!note.trim() || Number(count) < 1 || Number(count) > 50}
            loading={reserve.isPending}
            onClick={() => reserve.mutate()}
          >
            {t('documents.reservations.reserve')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function CreateJournalDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const t = useT()
  const client = useQueryClient()
  const formId = useId()
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [format, setFormat] = useState(DEFAULT_NUMBER_FORMAT)
  const [failure, setFailure] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      http.post<JournalRecord>('/journals', { name: name.trim(), prefix: prefix.trim(), format }),
    onSuccess: (journal) => {
      void client.invalidateQueries({ queryKey: documentKeys.all })
      onCreated(journal.id)
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.journals.create')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim() || numberFormatIssue(format) !== null}
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
          <Field label={t('documents.journals.name')} htmlFor={`${formId}-name`}>
            <Input
              id={`${formId}-name`}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('documents.journals.prefix')} htmlFor={`${formId}-prefix`}>
            <Input
              id={`${formId}-prefix`}
              value={prefix}
              maxLength={32}
              onChange={(event) => setPrefix(event.target.value)}
            />
          </Field>
          <Field
            label={t('documents.journals.format')}
            htmlFor={`${formId}-format`}
            hint={t('documents.journals.formatHint')}
          >
            <Input
              id={`${formId}-format`}
              value={format}
              className="font-mono"
              maxLength={64}
              onChange={(event) => setFormat(event.target.value)}
            />
          </Field>
          <FormatPreview prefix={prefix} format={format} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
