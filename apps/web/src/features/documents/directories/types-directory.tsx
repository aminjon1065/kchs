import {
  CONFIDENTIALITY_LEVELS,
  type Confidentiality,
  type DocumentTypeRecord,
  type DocumentTypeSettings,
  type DocumentTypeUpdateInput,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  type DataTableColumn,
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
import { FileCog, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { documentKeys, documentTypesQuery, journalsQuery } from '../queries.js'
import { errorText } from '../status.js'

const NO_JOURNAL = '__none__'

/**
 * Справочник типов документов (08-documents.md §2): просмотр и базовая правка —
 * название, журнал по умолчанию, допустимые грифы, правила типа, активность.
 * Ключ и направление неизменны; поля карточки правит конструктор (позже).
 */
export function TypesDirectory({ selectedId }: { selectedId: string | null }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: types = [], isLoading } = useQuery(documentTypesQuery(true))
  const [selected, setSelected] = useState<string | null>(selectedId)
  const current = types.find((type) => type.id === selected) ?? null

  const columns: Array<DataTableColumn<DocumentTypeRecord>> = [
    {
      key: 'name',
      header: t('documents.types.name'),
      minWidth: 220,
      cell: (type) => (
        <span className="flex items-center gap-2">
          <span className="truncate">{type.name[locale] ?? type.name.ru}</span>
          {type.isActive ? null : <Badge size="sm">{t('documents.types.inactive')}</Badge>}
        </span>
      ),
    },
    {
      key: 'direction',
      header: t('documents.types.direction'),
      width: 130,
      cell: (type) => t(`documents.directions.${type.direction}`),
    },
    {
      key: 'journal',
      header: t('documents.fields.journal'),
      width: 180,
      cell: (type) => type.journalName ?? <span className="text-fg-muted">—</span>,
    },
    {
      key: 'key',
      header: t('documents.types.key'),
      width: 160,
      cell: (type) => <span className="font-mono text-xs">{type.key}</span>,
    },
  ]

  return (
    <section aria-label={t('documents.types.title')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('documents.types.title')}</h1>}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-h-0">
          {!isLoading && types.length === 0 ? (
            <EmptyState icon={<FileCog />} title={t('documents.types.empty')} />
          ) : (
            <DataTable
              aria-label={t('documents.types.title')}
              rows={types}
              getRowId={(type) => type.id}
              columns={columns}
              loading={isLoading}
              onRowClick={(type) => setSelected(type.id)}
              onRowOpen={(type) => setSelected(type.id)}
            />
          )}
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface-2">
          {current ? (
            <TypePanel key={current.id} type={current} onClose={() => setSelected(null)} />
          ) : (
            <EmptyState compact icon={<FileCog />} title={t('documents.types.pick')} />
          )}
        </aside>
      </div>
    </section>
  )
}

const SETTING_SWITCHES = [
  'requireScan',
  'allowResolutions',
  'ackOnRegister',
  'autoControl',
] as const

interface TypeForm {
  nameRu: string
  nameEn: string
  nameTg: string
  journalId: string
  allowed: Confidentiality[]
  fallback: Confidentiality
  settings: DocumentTypeSettings
  deadlineDays: string
  retention: string
  active: boolean
}

/** Форма из записи типа: после сохранения запись перечитывается и форма «чистая». */
const formOf = (type: DocumentTypeRecord): TypeForm => ({
  nameRu: type.name.ru,
  nameEn: type.name.en ?? '',
  nameTg: type.name.tg ?? '',
  journalId: type.numbering.journalId ?? NO_JOURNAL,
  allowed: type.confidentialityAllowed,
  fallback: type.defaultConfidentiality,
  settings: type.settings,
  deadlineDays:
    type.settings.defaultDeadlineDays === null ? '' : String(type.settings.defaultDeadlineDays),
  retention: type.retentionYears === null ? '' : String(type.retentionYears),
  active: type.isActive,
})

function TypePanel({ type, onClose }: { type: DocumentTypeRecord; onClose: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const { data: journals = [] } = useQuery(journalsQuery())
  const editable = type.canManage
  const [form, setForm] = useState<TypeForm>(() => formOf(type))
  const set = (patch: Partial<TypeForm>) => setForm((current) => ({ ...current, ...patch }))
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(type))

  const toggleGrif = (level: Confidentiality, on: boolean) => {
    const next = CONFIDENTIALITY_LEVELS.filter((item) =>
      item === level ? on : form.allowed.includes(item),
    )
    if (next.length === 0) return
    set({
      allowed: next,
      fallback: next.includes(form.fallback) ? form.fallback : (next[0] ?? 'internal'),
    })
  }

  const days = form.deadlineDays.trim() === '' ? null : Number(form.deadlineDays)
  const years = form.retention.trim() === '' ? null : Number(form.retention)
  const invalid =
    !form.nameRu.trim() ||
    (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) ||
    (years !== null && (!Number.isInteger(years) || years < 0 || years > 100))

  const save = useMutation({
    mutationFn: () => {
      const body: DocumentTypeUpdateInput = {
        name: {
          ru: form.nameRu.trim(),
          ...(form.nameEn.trim() ? { en: form.nameEn.trim() } : {}),
          ...(form.nameTg.trim() ? { tg: form.nameTg.trim() } : {}),
        },
        numbering: {
          journalId: form.journalId === NO_JOURNAL ? null : form.journalId,
          format: type.numbering.format,
        },
        confidentialityAllowed: form.allowed,
        defaultConfidentiality: form.fallback,
        retentionYears: years,
        settings: { ...form.settings, defaultDeadlineDays: days },
        isActive: form.active,
      }
      return http.patch(`/document-types/${type.id}`, body)
    },
    onSuccess: () => {
      toast.show({ title: t('documents.types.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: documentKeys.all })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const text = (key: 'nameRu' | 'nameTg' | 'nameEn', label: string, required = false) => (
    <Field label={label} htmlFor={`${formId}-${key}`} required={required}>
      <Input
        id={`${formId}-${key}`}
        value={form[key]}
        maxLength={200}
        disabled={!editable}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  )

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{type.name.ru}</h2>
        <Badge size="sm">{t(`documents.directions.${type.direction}`)}</Badge>
        <IconButton size="sm" label={t('common.actions.close')} onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {text('nameRu', t('documents.types.nameRu'), true)}
      <div className="grid grid-cols-2 gap-3">
        {text('nameTg', t('documents.types.nameTg'))}
        {text('nameEn', t('documents.types.nameEn'))}
      </div>
      <Field label={t('documents.fields.journal')} hint={t('documents.types.journalHint')}>
        <Select
          value={form.journalId}
          onValueChange={(journalId) => set({ journalId })}
          disabled={!editable}
        >
          <SelectTrigger aria-label={t('documents.fields.journal')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_JOURNAL}>{t('documents.types.noJournal')}</SelectItem>
            {journals.map((journal) => (
              <SelectItem key={journal.id} value={journal.id}>
                {journal.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-fg-secondary">
          {t('documents.types.grifs')}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {CONFIDENTIALITY_LEVELS.map((level) => (
            <Checkbox
              key={level}
              label={t(`access.confidentiality.${level}`)}
              checked={form.allowed.includes(level)}
              disabled={!editable || (form.allowed.length === 1 && form.allowed.includes(level))}
              onCheckedChange={(checked) => toggleGrif(level, checked === true)}
            />
          ))}
        </div>
      </fieldset>
      <Field label={t('documents.types.defaultGrif')}>
        <Select
          value={form.fallback}
          onValueChange={(next) => set({ fallback: next as Confidentiality })}
          disabled={!editable}
        >
          <SelectTrigger aria-label={t('documents.types.defaultGrif')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {form.allowed.map((level) => (
              <SelectItem key={level} value={level}>
                {t(`access.confidentiality.${level}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <fieldset className="flex flex-col gap-2 border-t border-line pt-4">
        <legend className="sr-only">{t('documents.types.rules')}</legend>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {t('documents.types.rules')}
        </h3>
        {SETTING_SWITCHES.map((key) => (
          <Switch
            key={key}
            label={t(`documents.types.settings.${key}`)}
            checked={form.settings[key]}
            disabled={!editable}
            onCheckedChange={(checked) => set({ settings: { ...form.settings, [key]: checked } })}
          />
        ))}
      </fieldset>
      <Field label={t('documents.types.settings.defaultDeadlineDays')} htmlFor={`${formId}-days`}>
        <Input
          id={`${formId}-days`}
          type="number"
          min={1}
          max={365}
          value={form.deadlineDays}
          disabled={!editable}
          onChange={(event) => set({ deadlineDays: event.target.value })}
        />
      </Field>
      <Field label={t('documents.types.retentionYears')} htmlFor={`${formId}-retention`}>
        <Input
          id={`${formId}-retention`}
          type="number"
          min={0}
          max={100}
          value={form.retention}
          disabled={!editable}
          onChange={(event) => set({ retention: event.target.value })}
        />
      </Field>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {t('documents.card.typeFields')}
        </h3>
        {type.cardSchema.fields.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('documents.types.noFields')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {type.cardSchema.fields.map((field) => (
              <li key={field.key} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-fg">
                  {field.label[locale] ?? field.label.ru}
                </span>
                <span className="font-mono text-xs text-fg-muted">{field.type}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Switch
        label={t('documents.types.active')}
        checked={form.active}
        disabled={!editable}
        onCheckedChange={(active) => set({ active })}
      />
      {editable ? (
        <Button
          variant="primary"
          size="sm"
          disabled={invalid || !dirty}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('common.actions.save')}
        </Button>
      ) : null}
    </div>
  )
}
