import type { DatasetRecord, FormDefinition, FormListItem, FormSubject } from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardPen, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'
import { formDutiesQuery, formKeys, formsApi, formsQuery } from './queries.js'

/**
 * Экран «Формы сбора данных» (06-analytics-engine.md §13, ADR-0103): формы,
 * назначенные смотрящему, и — тем, кто их ведёт, — список с включением сбора.
 */
export function FormsScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const client = useQueryClient()
  const toast = useToast()
  const [spaceId, setSpaceId] = useState('all')
  const [creating, setCreating] = useState(false)

  const { data, isLoading } = useQuery(formsQuery(spaceId === 'all' ? {} : { spaceId }))
  const { data: duties } = useQuery(formDutiesQuery())
  const { data: spaces = [] } = useQuery(spacesQuery())

  const open = (form: { id: string; name: string }) =>
    openTab({
      kind: 'object',
      objectId: form.id,
      objectType: 'form',
      title: form.name,
      icon: 'form',
      mode: 'permanent',
    })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      formsApi.setEnabled(id, enabled),
    onSuccess: async (form) => {
      toast.show({
        title: form.enabled ? t('forms.toggle.enabled') : t('forms.toggle.disabled'),
        tone: 'success',
      })
      await client.invalidateQueries({ queryKey: formKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const columns: Array<DataTableColumn<FormListItem>> = [
    {
      key: 'name',
      header: t('forms.columns.name'),
      width: 280,
      cell: (row) => <span className="truncate font-medium">{row.name}</span>,
    },
    {
      key: 'dataset',
      header: t('forms.columns.dataset'),
      width: 220,
      cell: (row) => (
        <span className="truncate text-xs text-fg-secondary">{row.datasetName ?? '—'}</span>
      ),
    },
    {
      key: 'periodicity',
      header: t('forms.columns.periodicity'),
      width: 150,
      cell: (row) => <Badge tone="neutral">{t(`forms.periodicity.${row.periodicity}`)}</Badge>,
    },
    {
      key: 'assignments',
      header: t('forms.columns.assignments'),
      width: 130,
      cell: (row) => <span className="tabular">{row.assignments}</span>,
    },
    {
      key: 'overdue',
      header: t('forms.columns.overdue'),
      width: 120,
      cell: (row) =>
        row.overdue > 0 ? (
          <Badge tone="danger" size="sm">
            {row.overdue}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'state',
      header: t('forms.columns.state'),
      width: 110,
      cell: (row) => (
        <Switch
          checked={row.enabled}
          aria-label={t('forms.fields.enabled')}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
        />
      ),
    },
    {
      key: 'updated',
      header: t('forms.columns.updated'),
      width: 130,
      cell: (row) => formatRelativeTime(row.updatedAt, { locale }),
    },
  ]

  const items = data?.items ?? []
  const myDuties = duties?.items ?? []

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-canvas p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-fg">{t('forms.title')}</h2>
          <p className="text-sm text-fg-secondary">{t('forms.hint')}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('forms.create')}
        </Button>
      </div>

      {myDuties.length > 0 ? (
        <Card title={t('forms.duties.title')}>
          <ul className="flex flex-col gap-2">
            {myDuties.map((duty) => {
              const pending = duty.periods.filter(
                (period) =>
                  period.state === 'missing' ||
                  period.state === 'draft' ||
                  period.state === 'returned',
              )
              return (
                <li
                  key={`${duty.formId}:${duty.subject.kind}:${duty.subject.id}`}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2"
                >
                  <span className="font-medium">{duty.formName}</span>
                  <span className="text-xs text-fg-muted">{duty.subjectName ?? ''}</span>
                  <Badge tone={pending.length > 0 ? 'warning' : 'success'} size="sm">
                    {pending.length > 0
                      ? t('forms.duties.pending', { count: pending.length })
                      : t('forms.duties.done')}
                  </Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto"
                    onClick={() => open({ id: duty.formId, name: duty.formName })}
                  >
                    {t('forms.duties.open')}
                  </Button>
                </li>
              )
            })}
          </ul>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={spaceId} onValueChange={setSpaceId}>
          <SelectTrigger aria-label={t('forms.space')} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('forms.allSpaces')}</SelectItem>
            {spaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ClipboardPen className="size-5" />}
          title={t('forms.empty.title')}
          description={t('forms.empty.description')}
        />
      ) : (
        <div className="h-[28rem] min-h-0">
          <DataTable
            rows={items}
            getRowId={(row) => row.id}
            columns={columns}
            onRowClick={open}
            onRowOpen={open}
            aria-label={t('forms.title')}
          />
        </div>
      )}

      <CreateFormDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id, name) => {
          setCreating(false)
          open({ id, name })
        }}
      />
    </div>
  )
}

/** Новая форма: название, пространство, датасет и периодичность. */
function CreateFormDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string, name: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const [name, setName] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [datasetId, setDatasetId] = useState('')
  const [periodicity, setPeriodicity] =
    useState<FormDefinition['schedule']['periodicity']>('monthly')

  const { data: spaces = [] } = useQuery(spacesQuery())
  const { data: datasets } = useQuery(objectListQuery({ type: 'dataset', limit: 100 }))
  const { data: dataset } = useQuery({
    queryKey: ['forms', 'new-dataset', datasetId],
    queryFn: () => http.get<DatasetRecord>(`/datasets/${datasetId}`),
    enabled: datasetId.length > 0,
  })

  const create = useMutation({
    mutationFn: () => {
      const fields = (dataset?.fields ?? [])
        .filter((field) => field.type !== 'geometry' && !field.readOnly)
        .slice(0, 12)
        .map((field) => ({ key: field.key, required: false, hint: null }))
      const definition: FormDefinition = {
        datasetId,
        fields: fields.length > 0 ? fields : [{ key: '', required: false, hint: null }],
        auto: { unit: null, period: null, author: null, submittedAt: null },
        schedule: {
          periodicity,
          time: '08:00',
          dueWorkingDays: 1,
          startsOn: null,
          dueOn: periodicity === 'once' ? new Date().toISOString().slice(0, 10) : null,
        },
        assignments: [] as FormSubject[],
        review: { enabled: false, reviewers: [] },
        escalation: { enabled: true, afterWorkingDays: 1 },
      }
      return formsApi.create({ name, spaceId, definition, enabled: false })
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: formKeys.all })
      toast.show({ title: t('forms.created'), tone: 'success' })
      onCreated(result.id, name)
      setName('')
      setDatasetId('')
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('forms.createTitle')}
        size="md"
        footer={
          <Button
            variant="primary"
            disabled={name.trim().length === 0 || spaceId.length === 0 || datasetId.length === 0}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('forms.create')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('forms.name')} htmlFor={nameId} required>
            <Input
              id={nameId}
              value={name}
              placeholder={t('forms.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('forms.space')} required>
            <Select value={spaceId} onValueChange={setSpaceId}>
              <SelectTrigger aria-label={t('forms.space')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('forms.dataset')} required hint={t('forms.datasetHint')}>
            <Select value={datasetId} onValueChange={setDatasetId}>
              <SelectTrigger aria-label={t('forms.dataset')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(datasets?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('forms.fields.periodicity')}>
            <Select
              value={periodicity}
              onValueChange={(value) =>
                setPeriodicity(value as FormDefinition['schedule']['periodicity'])
              }
            >
              <SelectTrigger aria-label={t('forms.fields.periodicity')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['daily', 'weekly', 'monthly', 'once'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`forms.periodicity.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
