import {
  type DatasetField,
  FEED_TRANSFORMS,
  type FeedPathInfo,
  type FeedTransform,
} from '@kchs/contracts'
import {
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { useId } from 'react'
import { useT } from '~/shared/i18n.js'
import {
  emptyMapping,
  FEED_VALUE_KINDS,
  type FeedDraft,
  type FeedValueKind,
  type MappingDraft,
  NEW_FIELD_TYPES,
  NEW_GEOMETRY_FIELD,
  NEW_TERRITORY_FIELD,
  type NewFieldDraft,
  type NewFieldType,
  newFieldsFor,
} from './feed-form.js'
import { PathSelect, sample } from './feed-shared.js'

/** Поля геометрии и территории заполняет не сопоставление, а своя настройка ленты. */
const SPECIAL_TYPES = new Set(['geometry', 'territory'])
/** Шаблон ключа ленты без идентификатора — образец поля ввода (NASA FIRMS). */
const TEMPLATE_EXAMPLE = '{latitude}_{longitude}_{acq_date}'

/** Столбец нового датасета: путь записи и поле, которое из него заводится. */
export interface NewColumn extends NewFieldDraft {
  path: string
}

/** Сопоставление полей существующего датасета с записью ленты и выбор ключа. */
export function ExistingMapping({
  fields,
  draft,
  paths,
  onChange,
}: {
  fields: DatasetField[]
  draft: FeedDraft
  paths: readonly FeedPathInfo[]
  onChange: (next: Partial<FeedDraft>) => void
}) {
  const t = useT()
  const editable = fields.filter((field) => !SPECIAL_TYPES.has(field.type) && !field.readOnly)
  const setMapping = (key: string, next: Partial<MappingDraft>) =>
    onChange({
      mapping: { ...draft.mapping, [key]: { ...(draft.mapping[key] ?? emptyMapping()), ...next } },
    })
  return (
    <Card padded={false}>
      <div className="border-b border-line px-3 py-2 text-xs text-fg-secondary">
        {t('admin.dataSources.feed.mappingHint')}
      </div>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto">
        {editable.map((field) => {
          const mapping = draft.mapping[field.key] ?? emptyMapping()
          const label = field.label.ru
          return (
            <li
              key={field.key}
              className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 sm:w-48">
                <div className="truncate text-sm text-fg">{label}</div>
                <div className="font-mono text-2xs text-fg-muted">
                  {field.key} · {field.type}
                </div>
              </div>
              <Select
                value={mapping.kind}
                onValueChange={(value) => setMapping(field.key, { kind: value as FeedValueKind })}
              >
                <SelectTrigger
                  aria-label={t('admin.dataSources.feed.sourceOf', { field: label })}
                  className="h-7 text-xs sm:w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEED_VALUE_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`admin.dataSources.feed.kinds.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {mapping.kind === 'path' ? (
                  <>
                    <PathSelect
                      value={mapping.path}
                      onChange={(path) => setMapping(field.key, { path })}
                      paths={paths}
                      label={t('admin.dataSources.feed.pathOf', { field: label })}
                      className="h-7 min-w-0 flex-1 text-xs"
                    />
                    <Select
                      value={mapping.transform}
                      onValueChange={(value) =>
                        setMapping(field.key, { transform: value as FeedTransform })
                      }
                    >
                      <SelectTrigger
                        aria-label={t('admin.dataSources.feed.transformOf', { field: label })}
                        className="h-7 w-36 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FEED_TRANSFORMS.map((transform) => (
                          <SelectItem key={transform} value={transform}>
                            {t(`admin.dataSources.feed.transforms.${transform}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : null}
                {mapping.kind === 'const' ? (
                  <Input
                    aria-label={t('admin.dataSources.feed.constantOf', { field: label })}
                    className="h-7 text-xs"
                    value={mapping.constant}
                    onChange={(event) => setMapping(field.key, { constant: event.target.value })}
                  />
                ) : null}
                {mapping.kind === 'template' ? (
                  <Input
                    aria-label={t('admin.dataSources.feed.templateOf', { field: label })}
                    className="h-7 font-mono text-xs"
                    placeholder={TEMPLATE_EXAMPLE}
                    value={mapping.template}
                    onChange={(event) => setMapping(field.key, { template: event.target.value })}
                  />
                ) : null}
                {mapping.kind === 'date_time' ? (
                  <>
                    <PathSelect
                      value={mapping.date}
                      onChange={(date) => setMapping(field.key, { date })}
                      paths={paths}
                      label={t('admin.dataSources.feed.dateOf', { field: label })}
                      className="h-7 min-w-0 flex-1 text-xs"
                    />
                    <PathSelect
                      value={mapping.time}
                      onChange={(time) => setMapping(field.key, { time })}
                      paths={paths}
                      label={t('admin.dataSources.feed.timeOf', { field: label })}
                      className="h-7 min-w-0 flex-1 text-xs"
                    />
                  </>
                ) : null}
              </div>
              <Checkbox
                label={t('admin.dataSources.feed.key')}
                checked={draft.keyFields.includes(field.key)}
                disabled={mapping.kind === 'none'}
                onCheckedChange={(checked) =>
                  onChange({
                    keyFields:
                      checked === true
                        ? [...draft.keyFields, field.key]
                        : draft.keyFields.filter((key) => key !== field.key),
                  })
                }
              />
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** Новый датасет: отмеченные пути записи становятся полями с ключом, подписью и типом. */
export function NewColumns({
  paths,
  columns,
  onColumnsChange,
  keyFields,
  onKeyFieldsChange,
  datasetName,
  onDatasetNameChange,
}: {
  paths: readonly FeedPathInfo[]
  columns: NewColumn[]
  onColumnsChange: (columns: NewColumn[]) => void
  keyFields: string[]
  onKeyFieldsChange: (keys: string[]) => void
  datasetName: string
  onDatasetNameChange: (name: string) => void
}) {
  const t = useT()
  const id = useId()
  const plain = paths.filter((info) => info.type !== 'geometry')
  const toggle = (info: FeedPathInfo, checked: boolean) => {
    if (!checked) {
      const removed = columns.find((column) => column.path === info.path)
      onColumnsChange(columns.filter((column) => column.path !== info.path))
      if (removed) onKeyFieldsChange(keyFields.filter((key) => key !== removed.key))
      return
    }
    const [field] = newFieldsFor([info]).map((draft) => ({
      ...draft,
      key: uniqueKey(draft.key, columns),
    }))
    if (field) onColumnsChange([...columns, { ...field, path: info.path }])
  }
  const update = (path: string, next: Partial<NewFieldDraft>) =>
    onColumnsChange(
      columns.map((column) => (column.path === path ? { ...column, ...next } : column)),
    )
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('admin.dataSources.feed.datasetName')}
        htmlFor={`${id}-dataset`}
        hint={t('admin.dataSources.feed.datasetNameHint')}
      >
        <Input
          id={`${id}-dataset`}
          maxLength={200}
          value={datasetName}
          onChange={(event) => onDatasetNameChange(event.target.value)}
        />
      </Field>
      <Card padded={false}>
        <div className="border-b border-line px-3 py-2 text-xs text-fg-secondary">
          {t('admin.dataSources.feed.newFieldsHint')}
        </div>
        <ul className="max-h-80 divide-y divide-line overflow-y-auto">
          {plain.map((info) => {
            const column = columns.find((item) => item.path === info.path)
            return (
              <li
                key={info.path}
                className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
              >
                <Checkbox
                  label={info.path}
                  checked={Boolean(column)}
                  onCheckedChange={(checked) => toggle(info, checked === true)}
                />
                <span className="truncate text-xs text-fg-muted sm:w-40">
                  {sample(info.sample)}
                </span>
                {column ? (
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <Input
                      aria-label={t('admin.dataSources.feed.fieldLabelOf', { path: info.path })}
                      className="h-7 min-w-0 flex-1 text-xs"
                      value={column.label}
                      onChange={(event) => update(info.path, { label: event.target.value })}
                    />
                    <Select
                      value={column.type}
                      onValueChange={(value) => update(info.path, { type: value as NewFieldType })}
                    >
                      <SelectTrigger
                        aria-label={t('admin.dataSources.feed.fieldTypeOf', { path: info.path })}
                        className="h-7 w-36 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NEW_FIELD_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`admin.dataSources.feed.types.${type}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Checkbox
                      label={t('admin.dataSources.feed.key')}
                      checked={keyFields.includes(column.key)}
                      onCheckedChange={(checked) =>
                        onKeyFieldsChange(
                          checked === true
                            ? [...keyFields, column.key]
                            : keyFields.filter((key) => key !== column.key),
                        )
                      }
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}

function uniqueKey(key: string, columns: readonly NewColumn[]): string {
  const taken = new Set([
    ...columns.map((column) => column.key),
    NEW_GEOMETRY_FIELD,
    NEW_TERRITORY_FIELD,
  ])
  let next = key
  for (let index = 2; taken.has(next); index++) next = `${key}_${index}`
  return next
}
