import type { DatasetField, DatasetFieldPatch, DatasetRecord, FieldSemantic } from '@kchs/contracts'
import { Button, Field, Input, Switch, Textarea, useToast } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { objectListQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { LOOKUP_TYPES, NUMERIC_TYPES, PICKABLE_SEMANTICS } from './field-types.js'
import { datasetQuery } from './queries.js'
import { errorText, schemaApi } from './schema-queries.js'
import { ChoiceField, labelOf, NONE, useSchemaRefresh } from './schema-shared.js'

type Lookup = NonNullable<DatasetField['lookup']>

export function FieldPropertiesForm({
  dataset,
  field,
  canManage,
}: {
  dataset: DatasetRecord
  field: DatasetField
  canManage: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const [label, setLabel] = useState(field.label[locale] ?? field.label.ru ?? '')
  const [description, setDescription] = useState(field.description ?? '')
  const [semantic, setSemantic] = useState<FieldSemantic>(field.semantic)
  const [unit, setUnit] = useState(field.unit ?? '')
  const [precision, setPrecision] = useState(
    field.format?.precision !== undefined ? String(field.format.precision) : '',
  )
  const [required, setRequired] = useState(field.required)
  const [indexed, setIndexed] = useState(field.indexed)
  const [sensitive, setSensitive] = useState(field.sensitive)
  const [lookup, setLookup] = useState<Lookup | null>(field.lookup ?? null)
  const numeric = NUMERIC_TYPES.has(field.type)

  const save = useMutation({
    mutationFn: () => {
      const patch: DatasetFieldPatch = {
        label: { ...field.label, [locale]: label.trim() || field.key },
        description: description.trim() || null,
        semantic,
        unit: unit.trim() || null,
        required,
        sensitive,
        // Индекс — DDL: отправляем только при настоящей смене
        ...(indexed !== field.indexed ? { indexed } : {}),
        ...(numeric
          ? {
              format:
                precision === ''
                  ? { ...field.format, precision: undefined }
                  : { ...field.format, precision: Number(precision) },
            }
          : {}),
        ...(JSON.stringify(lookup) !== JSON.stringify(field.lookup ?? null) ? { lookup } : {}),
      }
      return schemaApi.updateField(dataset.id, field.key, patch)
    },
    onSuccess: () => {
      toast.show({ title: t('data.dataset.editor.saved'), tone: 'success' })
      refresh()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const disabled = !canManage
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <Field label={t('data.dataset.editor.label')}>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={disabled}
          aria-label={t('data.dataset.editor.label')}
        />
      </Field>
      <Field label={t('data.dataset.editor.key')} hint={t('data.dataset.editor.keyHint')}>
        <Input value={field.key} mono readOnly disabled aria-label={t('data.dataset.editor.key')} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <ChoiceField
          label={t('data.dataset.editor.semantic')}
          value={semantic}
          onChange={setSemantic}
          disabled={disabled}
          options={PICKABLE_SEMANTICS.map((value) => ({
            value,
            label: t(`data.semantics.${value}`),
          }))}
        />
        <Field label={t('data.dataset.editor.unit')}>
          <Input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            disabled={disabled}
            aria-label={t('data.dataset.editor.unit')}
          />
        </Field>
      </div>
      {numeric ? (
        <Field label={t('data.dataset.editor.precision')}>
          <Input
            type="number"
            min={0}
            max={12}
            value={precision}
            onChange={(e) => setPrecision(e.target.value)}
            disabled={disabled}
            aria-label={t('data.dataset.editor.precision')}
          />
        </Field>
      ) : null}
      <Field label={t('data.dataset.editor.description')}>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={disabled}
          aria-label={t('data.dataset.editor.description')}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <Switch
          checked={required}
          onCheckedChange={setRequired}
          disabled={disabled}
          label={t('data.dataset.editor.required')}
        />
        <Switch
          checked={indexed}
          onCheckedChange={setIndexed}
          disabled={disabled || field.type === 'geometry'}
          label={t('data.dataset.editor.indexed')}
        />
        <Switch
          checked={sensitive}
          onCheckedChange={setSensitive}
          disabled={disabled}
          label={t('data.dataset.editor.sensitive')}
        />
      </div>
      {LOOKUP_TYPES.has(field.type) ? (
        <LookupEditor dataset={dataset} value={lookup} onChange={setLookup} disabled={disabled} />
      ) : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={save.isPending}>
            {t('data.dataset.editor.save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

/** Справочник поля: датасет пространства, поле ключа и поле подписи. */
function LookupEditor({
  dataset,
  value,
  onChange,
  disabled,
}: {
  dataset: DatasetRecord
  value: Lookup | null
  onChange: (value: Lookup | null) => void
  disabled?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const { data: candidates } = useQuery(
    objectListQuery({ spaceId: dataset.spaceId, types: 'dataset', limit: 100 }),
  )
  const { data: reference } = useQuery({
    ...datasetQuery(value?.datasetId ?? ''),
    enabled: Boolean(value?.datasetId),
  })
  const fields = reference?.fields ?? []

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-medium text-fg-secondary">
        {t('data.dataset.editor.lookup.title')}
      </legend>
      <p className="text-2xs text-fg-muted">{t('data.dataset.editor.lookup.hint')}</p>
      <ChoiceField
        label={t('data.dataset.editor.lookup.dataset')}
        value={value?.datasetId ?? NONE}
        disabled={disabled}
        onChange={(next) =>
          onChange(next === NONE ? null : { datasetId: next, keyField: '', labelField: '' })
        }
        options={[
          { value: NONE, label: t('data.dataset.editor.lookup.none') },
          ...(candidates?.items ?? []).map((item) => ({ value: item.id, label: item.title })),
        ]}
      />
      {value && fields.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          <ChoiceField
            label={t('data.dataset.editor.lookup.keyField')}
            value={value.keyField || NONE}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, keyField: next === NONE ? '' : next })}
            options={[
              { value: NONE, label: '—' },
              ...fields.map((item) => ({ value: item.key, label: labelOf(item, locale) })),
            ]}
          />
          <ChoiceField
            label={t('data.dataset.editor.lookup.labelField')}
            value={value.labelField || NONE}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, labelField: next === NONE ? '' : next })}
            options={[
              { value: NONE, label: '—' },
              ...fields.map((item) => ({ value: item.key, label: labelOf(item, locale) })),
            ]}
          />
        </div>
      ) : null}
    </fieldset>
  )
}
