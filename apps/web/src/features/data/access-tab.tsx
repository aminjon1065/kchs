import type {
  DatasetColumnPolicy,
  DatasetColumnPolicyMode,
  DatasetRecord,
  DatasetRowPolicy,
  FilterNode,
  PrincipalRef,
} from '@kchs/contracts'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  ErrorState,
  Field,
  FilterBuilder,
  type FilterField,
  FilterSummary,
  IconButton,
  SegmentedControl,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import {
  PrincipalLine,
  PrincipalPicker,
  usePrincipalLabel,
} from '~/features/access/principal-picker.js'
import { ApiError, http } from '~/shared/api/client.js'
import { fieldLabel, filterFieldsOf } from './field-types.js'
import { dataKeys, datasetPoliciesQuery } from './queries.js'

type Editing =
  | { kind: 'rows'; policy: DatasetRowPolicy | null }
  | { kind: 'columns'; policy: DatasetColumnPolicy | null }

type Removing =
  | { kind: 'rows'; policy: DatasetRowPolicy }
  | { kind: 'columns'; policy: DatasetColumnPolicy }

const MODES: DatasetColumnPolicyMode[] = ['hide', 'mask']

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/**
 * Вкладка «Доступ» датасета (03-access-model.md «Строки и столбцы датасетов»):
 * политики строк — кому какие строки видны, политики столбцов — скрыть или
 * замаскировать поля. Видна `manage+`; управляющих политики не ограничивают.
 */
export function AccessTab({ dataset }: { dataset: DatasetRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const labelOf = usePrincipalLabel()
  const { data: policies, isLoading, error, refetch } = useQuery(datasetPoliciesQuery(dataset.id))
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<Removing | null>(null)
  const fields = filterFieldsOf(dataset.fields, locale)
  const labels = new Map(dataset.fields.map((field) => [field.key, fieldLabel(field, locale)]))

  const remove = useMutation({
    mutationFn: (target: Removing) =>
      http.delete(`/datasets/${dataset.id}/policies/${target.kind}/${target.policy.id}`),
    onSuccess: () => {
      toast.show({ title: t('data.policies.removed'), tone: 'success' })
      void client.invalidateQueries({ queryKey: dataKeys.policies(dataset.id) })
      setRemoving(null)
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
  })

  if (error) {
    return (
      <ErrorState
        description={errorText(error, t('errors.unknown'))}
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <Callout tone="info">
        {t('data.policies.intro')}
        {policies && policies.rows.length > 0 ? ` ${t('data.policies.defaultNothing')}` : null}
      </Callout>

      <PolicySection
        title={t('data.policies.rows.title')}
        hint={t('data.policies.rows.hint')}
        addLabel={t('data.policies.rows.add')}
        onAdd={() => setEditing({ kind: 'rows', policy: null })}
        loading={isLoading}
        empty={policies?.rows.length === 0 ? t('data.policies.rows.empty') : null}
      >
        {policies?.rows.map((policy) => (
          <PolicyItem
            key={policy.id}
            principal={policy.principal}
            editLabel={t('data.policies.edit', { principal: labelOf(policy.principal).title })}
            removeLabel={t('data.policies.remove', { principal: labelOf(policy.principal).title })}
            onEdit={() => setEditing({ kind: 'rows', policy })}
            onRemove={() => setRemoving({ kind: 'rows', policy })}
          >
            <FilterSummary fields={fields} value={policy.filter} />
            {policy.note ? <p className="text-xs text-fg-muted">{policy.note}</p> : null}
          </PolicyItem>
        ))}
      </PolicySection>

      <PolicySection
        title={t('data.policies.columns.title')}
        hint={t('data.policies.columns.hint')}
        addLabel={t('data.policies.columns.add')}
        onAdd={() => setEditing({ kind: 'columns', policy: null })}
        loading={isLoading}
        empty={policies?.columns.length === 0 ? t('data.policies.columns.empty') : null}
      >
        {policies?.columns.map((policy) => (
          <PolicyItem
            key={policy.id}
            principal={policy.principal}
            editLabel={t('data.policies.edit', { principal: labelOf(policy.principal).title })}
            removeLabel={t('data.policies.remove', { principal: labelOf(policy.principal).title })}
            onEdit={() => setEditing({ kind: 'columns', policy })}
            onRemove={() => setRemoving({ kind: 'columns', policy })}
          >
            <span className="flex flex-wrap items-center gap-1">
              <Badge size="sm" tone={policy.mode === 'hide' ? 'danger' : 'warning'}>
                {t(`data.policies.modes.${policy.mode}`)}
              </Badge>
              {policy.fields.map((key) => (
                <Badge key={key} size="sm" tone="outline">
                  {labels.get(key) ?? key}
                </Badge>
              ))}
            </span>
          </PolicyItem>
        ))}
      </PolicySection>

      {editing?.kind === 'rows' ? (
        <RowPolicyDialog
          dataset={dataset}
          fields={fields}
          policy={editing.policy}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing?.kind === 'columns' ? (
        <ColumnPolicyDialog
          dataset={dataset}
          labels={labels}
          policy={editing.policy}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('data.policies.removeTitle')}
        description={
          removing
            ? t(
                removing.kind === 'rows'
                  ? 'data.policies.removeRowsBody'
                  : 'data.policies.removeColumnsBody',
                { principal: labelOf(removing.policy.principal).title },
              )
            : ''
        }
        confirmLabel={t('common.actions.delete')}
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing)
        }}
      />
    </div>
  )
}

function PolicySection({
  title,
  hint,
  addLabel,
  onAdd,
  loading,
  empty,
  children,
}: {
  title: string
  hint: string
  addLabel: string
  onAdd: () => void
  loading: boolean
  empty: string | null
  children: ReactNode
}) {
  return (
    <Card
      padded={false}
      title={title}
      action={
        <Button variant="secondary" size="sm" icon={<Plus className="size-3.5" />} onClick={onAdd}>
          {addLabel}
        </Button>
      }
    >
      <p className="border-b border-line px-4 py-2 text-xs text-fg-secondary">{hint}</p>
      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : empty ? (
        <p className="px-4 py-6 text-center text-sm text-fg-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line">{children}</ul>
      )}
    </Card>
  )
}

function PolicyItem({
  principal,
  editLabel,
  removeLabel,
  onEdit,
  onRemove,
  children,
}: {
  principal: PrincipalRef
  editLabel: string
  removeLabel: string
  onEdit: () => void
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <li className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] md:items-center">
      <PrincipalLine principal={principal} />
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
      <span className="flex items-center gap-1 justify-self-end">
        <IconButton label={editLabel} size="sm" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </IconButton>
        <IconButton label={removeLabel} size="sm" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    </li>
  )
}

/** Группа полей формы с подписью-легендой: для составных редакторов. */
function FieldGroup({
  legend,
  hint,
  children,
}: {
  legend: string
  hint?: string
  children: ReactNode
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-fg-secondary">{legend}</legend>
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </fieldset>
  )
}

function usePolicySaved(datasetId: string, onClose: () => void) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  return () => {
    toast.show({ title: t('data.policies.saved'), tone: 'success' })
    void client.invalidateQueries({ queryKey: dataKeys.policies(datasetId) })
    onClose()
  }
}

function RowPolicyDialog({
  dataset,
  fields,
  policy,
  onClose,
}: {
  dataset: DatasetRecord
  fields: FilterField[]
  policy: DatasetRowPolicy | null
  onClose: () => void
}) {
  const t = useT()
  const noteId = useId()
  const [principal, setPrincipal] = useState<PrincipalRef | null>(policy?.principal ?? null)
  const [filter, setFilter] = useState<FilterNode | null>(policy?.filter ?? null)
  const [note, setNote] = useState(policy?.note ?? '')
  const [failure, setFailure] = useState<string | null>(null)
  const saved = usePolicySaved(dataset.id, onClose)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        principal: principal ? { type: principal.type, id: principal.id } : undefined,
        filter,
        note: note.trim() || null,
      }
      return policy
        ? http.patch(`/datasets/${dataset.id}/policies/rows/${policy.id}`, body)
        : http.post(`/datasets/${dataset.id}/policies/rows`, body)
    },
    onSuccess: saved,
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t(policy ? 'data.policies.rows.editTitle' : 'data.policies.rows.createTitle')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!principal || !filter}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <FieldGroup legend={t('data.policies.principal')}>
            <PrincipalPicker
              value={principal}
              onChange={setPrincipal}
              spaceId={dataset.spaceId}
              label={t('data.policies.principal')}
            />
          </FieldGroup>
          <FieldGroup
            legend={t('data.policies.rows.filter')}
            hint={t('data.policies.rows.filterHint')}
          >
            <FilterBuilder fields={fields} value={filter} onChange={setFilter} />
          </FieldGroup>
          <Field label={t('data.policies.note')} htmlFor={noteId}>
            <Textarea
              id={noteId}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ColumnPolicyDialog({
  dataset,
  labels,
  policy,
  onClose,
}: {
  dataset: DatasetRecord
  labels: Map<string, string>
  policy: DatasetColumnPolicy | null
  onClose: () => void
}) {
  const t = useT()
  const [principal, setPrincipal] = useState<PrincipalRef | null>(policy?.principal ?? null)
  const [mode, setMode] = useState<DatasetColumnPolicyMode>(policy?.mode ?? 'mask')
  const [selected, setSelected] = useState<Set<string>>(new Set(policy?.fields ?? []))
  const [failure, setFailure] = useState<string | null>(null)
  const saved = usePolicySaved(dataset.id, onClose)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        principal: principal ? { type: principal.type, id: principal.id } : undefined,
        mode,
        // Порядок полей — как в схеме
        fields: dataset.fields.map((field) => field.key).filter((key) => selected.has(key)),
      }
      return policy
        ? http.patch(`/datasets/${dataset.id}/policies/columns/${policy.id}`, body)
        : http.post(`/datasets/${dataset.id}/policies/columns`, body)
    },
    onSuccess: saved,
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  const toggle = (key: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t(policy ? 'data.policies.columns.editTitle' : 'data.policies.columns.createTitle')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!principal || selected.size === 0}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <FieldGroup legend={t('data.policies.principal')}>
            <PrincipalPicker
              value={principal}
              onChange={setPrincipal}
              spaceId={dataset.spaceId}
              label={t('data.policies.principal')}
            />
          </FieldGroup>
          <FieldGroup
            legend={t('data.policies.columns.mode')}
            hint={t(`data.policies.modeHints.${mode}`)}
          >
            <SegmentedControl
              value={mode}
              onValueChange={setMode}
              options={MODES.map((value) => ({ value, label: t(`data.policies.modes.${value}`) }))}
              aria-label={t('data.policies.columns.mode')}
            />
          </FieldGroup>
          <FieldGroup legend={t('data.policies.columns.fields')}>
            <ul className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2">
              {dataset.fields.map((field) => (
                <li key={field.key}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-xs px-1.5 py-1 text-sm hover:bg-surface-3">
                    <Checkbox
                      checked={selected.has(field.key)}
                      onCheckedChange={(checked) => toggle(field.key, checked === true)}
                    />
                    <span className="min-w-0 truncate">{labels.get(field.key) ?? field.key}</span>
                  </label>
                </li>
              ))}
            </ul>
          </FieldGroup>
        </div>
      </DialogContent>
    </Dialog>
  )
}
