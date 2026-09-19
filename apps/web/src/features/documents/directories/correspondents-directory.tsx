import {
  CORRESPONDENT_KINDS,
  type CorrespondentKind,
  type CorrespondentRecord,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Field,
  IconButton,
  Input,
  PanelToolbar,
  SearchInput,
  SegmentedControl,
  Skeleton,
  Textarea,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Contact, Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { correspondentQuery, correspondentsQuery, documentKeys } from '../queries.js'
import { errorText } from '../status.js'

/**
 * Справочник корреспондентов (08-documents.md §5): организации и лица —
 * отправители входящих и адресаты исходящих. Заводит и правит делопроизводитель
 * (`documents.register`); поиск — по названию, короткому имени и ИНН.
 */
export function CorrespondentsDirectory({ selectedId }: { selectedId: string | null }) {
  const t = useT()
  const { data: me } = useQuery(meQuery())
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 200)
  const { data, isLoading } = useQuery(correspondentsQuery(q))
  const rows = data?.items ?? []
  const [selected, setSelected] = useState<string | 'new' | null>(selectedId)
  const canCreate = me?.capabilities.includes('documents.register') ?? false

  const columns: Array<DataTableColumn<CorrespondentRecord>> = [
    {
      key: 'name',
      header: t('documents.correspondents.name'),
      minWidth: 240,
      cell: (row) => <span className="truncate">{row.name}</span>,
    },
    {
      key: 'kind',
      header: t('documents.correspondents.kind'),
      width: 130,
      cell: (row) => <Badge size="sm">{t(`documents.correspondents.kinds.${row.kind}`)}</Badge>,
    },
    {
      key: 'taxId',
      header: t('documents.correspondents.taxId'),
      width: 140,
      cell: (row) => <span className="font-mono text-xs tabular">{row.details.taxId ?? ''}</span>,
    },
    {
      key: 'documents',
      header: t('documents.journals.documents'),
      width: 110,
      cell: (row) => <span className="tabular">{row.documentCount}</span>,
    },
  ]

  return (
    <section
      aria-label={t('documents.correspondents.title')}
      className="flex h-full min-h-0 flex-col"
    >
      <PanelToolbar
        left={
          <>
            <h1 className="text-sm font-semibold text-fg">{t('documents.correspondents.title')}</h1>
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder={t('documents.correspondents.search')}
              aria-label={t('documents.correspondents.search')}
              className="h-7 w-64"
            />
          </>
        }
        right={
          canCreate ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setSelected('new')}
            >
              {t('documents.correspondents.create')}
            </Button>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-h-0">
          {!isLoading && rows.length === 0 ? (
            <EmptyState
              icon={<Contact />}
              title={
                q ? t('documents.correspondents.notFound') : t('documents.correspondents.empty')
              }
            />
          ) : (
            <DataTable
              aria-label={t('documents.correspondents.title')}
              rows={rows}
              getRowId={(row) => row.id}
              columns={columns}
              loading={isLoading}
              onRowClick={(row) => setSelected(row.id)}
              onRowOpen={(row) => setSelected(row.id)}
            />
          )}
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface-2">
          {selected === 'new' ? (
            <CorrespondentForm
              key="new"
              record={null}
              onClose={() => setSelected(null)}
              onSaved={(id) => setSelected(id)}
            />
          ) : selected ? (
            <CorrespondentPanel key={selected} id={selected} onClose={() => setSelected(null)} />
          ) : (
            <EmptyState compact icon={<Contact />} title={t('documents.correspondents.pick')} />
          )}
        </aside>
      </div>
    </section>
  )
}

function CorrespondentPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: record, isLoading } = useQuery(correspondentQuery(id))
  if (isLoading || !record) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  return <CorrespondentForm record={record} onClose={onClose} onSaved={() => undefined} />
}

interface FormValue {
  kind: CorrespondentKind
  name: string
  shortName: string
  taxId: string
  address: string
  head: string
  email: string
  phone: string
  note: string
}

const formOf = (record: CorrespondentRecord | null): FormValue => ({
  kind: record?.kind ?? 'organization',
  name: record?.name ?? '',
  shortName: record?.details.shortName ?? '',
  taxId: record?.details.taxId ?? '',
  address: record?.details.address ?? '',
  head: record?.details.head ?? '',
  email: record?.contacts.email ?? '',
  phone: record?.contacts.phone ?? '',
  note: record?.details.note ?? '',
})

/** Пустые строки не сохраняются: справочник хранит только заполненные реквизиты. */
const compact = (entries: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(entries)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value !== ''),
  )

function CorrespondentForm({
  record,
  onClose,
  onSaved,
}: {
  record: CorrespondentRecord | null
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [value, setValue] = useState<FormValue>(() => formOf(record))
  const set = (patch: Partial<FormValue>) => setValue((current) => ({ ...current, ...patch }))
  const editable = record ? record.canEdit : true
  const dirty = JSON.stringify(value) !== JSON.stringify(formOf(record))

  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind: value.kind,
        name: value.name.trim(),
        details: {
          // Реквизиты, которых нет в форме, сохраняются как были
          ...record?.details,
          ...Object.fromEntries(
            ['shortName', 'taxId', 'address', 'head', 'note'].map((key) => [key, undefined]),
          ),
          ...compact({
            shortName: value.shortName,
            taxId: value.taxId,
            address: value.address,
            head: value.head,
            note: value.note,
          }),
        },
        contacts: {
          ...record?.contacts,
          email: undefined,
          phone: undefined,
          ...compact({ email: value.email, phone: value.phone }),
        },
      }
      return record
        ? http.patch<CorrespondentRecord>(`/correspondents/${record.id}`, body)
        : http.post<CorrespondentRecord>('/correspondents', body)
    },
    onSuccess: (saved) => {
      toast.show({
        title: record ? t('documents.correspondents.saved') : t('documents.correspondents.created'),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      void client.invalidateQueries({ queryKey: documentKeys.correspondent(saved.id) })
      onSaved(saved.id)
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const input = (key: keyof FormValue, label: string, maxLength: number) => (
    <Field label={label} htmlFor={`${formId}-${key}`}>
      <Input
        id={`${formId}-${key}`}
        value={value[key]}
        maxLength={maxLength}
        disabled={!editable}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  )

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {record ? record.name : t('documents.correspondents.create')}
        </h2>
        <IconButton size="sm" label={t('common.actions.close')} onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {editable ? (
        <SegmentedControl<CorrespondentKind>
          aria-label={t('documents.correspondents.kind')}
          value={value.kind}
          onValueChange={(kind) => set({ kind })}
          options={CORRESPONDENT_KINDS.map((kind) => ({
            value: kind,
            label: t(`documents.correspondents.kinds.${kind}`),
          }))}
        />
      ) : (
        <Badge className="self-start">{t(`documents.correspondents.kinds.${value.kind}`)}</Badge>
      )}
      <Field label={t('documents.correspondents.name')} htmlFor={`${formId}-name`} required>
        <Textarea
          id={`${formId}-name`}
          rows={2}
          value={value.name}
          maxLength={300}
          disabled={!editable}
          onChange={(event) => set({ name: event.target.value })}
        />
      </Field>
      {input('shortName', t('documents.correspondents.shortName'), 200)}
      <div className="grid grid-cols-2 gap-3">
        {input('taxId', t('documents.correspondents.taxId'), 32)}
        {input('head', t('documents.correspondents.head'), 200)}
      </div>
      {input('address', t('documents.correspondents.address'), 500)}
      <div className="grid grid-cols-2 gap-3">
        {input('email', t('documents.correspondents.email'), 200)}
        {input('phone', t('documents.correspondents.phone'), 64)}
      </div>
      <Field label={t('documents.correspondents.note')} htmlFor={`${formId}-note`}>
        <Textarea
          id={`${formId}-note`}
          rows={3}
          value={value.note}
          maxLength={2000}
          disabled={!editable}
          onChange={(event) => set({ note: event.target.value })}
        />
      </Field>
      {record ? (
        <p className="text-xs text-fg-muted">
          {t('documents.correspondents.usage', { count: record.documentCount })}
        </p>
      ) : null}
      {editable ? (
        <Button
          variant="primary"
          size="sm"
          disabled={!value.name.trim() || !dirty}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {record ? t('common.actions.save') : t('common.actions.create')}
        </Button>
      ) : null}
    </div>
  )
}
