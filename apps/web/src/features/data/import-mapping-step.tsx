import {
  type DatasetRecord,
  type FieldSemantic,
  IMPORT_FIELD_TYPES,
  type ImportAnalysis,
  type ImportFieldType,
  type ImportMode,
} from '@kchs/contracts'
import { formatPercent } from '@kchs/fields'
import {
  Callout,
  Checkbox,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kchs/ui'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { PICKABLE_SEMANTICS } from './field-types.js'
import {
  importableFields,
  type MappingProblem,
  type MappingRow,
  supportsReview,
} from './import-mapping.js'
import { ChoiceSelect } from './import-structure-step.js'

/** Шаг 3 мастера импорта (ADR-0046): поля файла → поля датасета, ключ и режим загрузки. */

const MODES: ImportMode[] = ['append', 'upsert', 'sync', 'replace']
const SKIP = '__skip'
function problemText(t: ReturnType<typeof useT>, problem: MappingProblem): string {
  switch (problem.code) {
    case 'duplicate':
      return t('data.import.mapping.errors.duplicate', { key: problem.key })
    case 'unmapped':
      return t('data.import.mapping.errors.unmapped', { column: problem.column })
    case 'keyNotInFile':
      return t('data.import.mapping.errors.keyNotInFile', { keys: problem.keys.join(', ') })
    default:
      return t(`data.import.mapping.errors.${problem.code}`)
  }
}

function geometryText(t: ReturnType<typeof useT>, analysis: ImportAnalysis): string | null {
  const geometry = analysis.geometry
  if (!geometry) return null
  const columnName = (index: number) =>
    analysis.columns.find((column) => column.index === index)?.name ?? String(index + 1)
  const source =
    geometry.kind === 'latlon'
      ? t('data.import.mapping.geometrySource.latlon', {
          lat: columnName(geometry.lat),
          lon: columnName(geometry.lon),
        })
      : geometry.kind === 'features'
        ? t('data.import.mapping.geometrySource.features')
        : t(`data.import.mapping.geometrySource.${geometry.kind}`, {
            column: columnName(geometry.column),
          })
  return t('data.import.mapping.geometry', { source })
}

export function MappingStep({
  analysis,
  rows,
  onRowsChange,
  dataset,
  name,
  onNameChange,
  mode,
  onModeChange,
  useGeometry,
  onUseGeometryChange,
  review,
  onReviewChange,
  problems,
}: {
  analysis: ImportAnalysis
  rows: MappingRow[]
  onRowsChange: (rows: MappingRow[]) => void
  dataset?: DatasetRecord
  name: string
  onNameChange: (name: string) => void
  mode: ImportMode
  onModeChange: (mode: ImportMode) => void
  useGeometry: boolean
  onUseGeometryChange: (value: boolean) => void
  review: boolean
  onReviewChange: (value: boolean) => void
  problems: MappingProblem[]
}) {
  const t = useT()
  const locale = useLocale()
  const fields = dataset ? importableFields(dataset) : []
  const hasGeometryTarget = dataset ? dataset.fields.some((f) => f.type === 'geometry') : true
  const geometry = hasGeometryTarget ? geometryText(t, analysis) : null
  const columns = new Map(analysis.columns.map((column) => [column.index, column]))
  const update = (index: number, patch: Partial<MappingRow>) =>
    onRowsChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const typeOptions = IMPORT_FIELD_TYPES.map((type) => ({
    value: type,
    label: t(`data.types.${type}`),
  }))
  const semanticOptions = PICKABLE_SEMANTICS.map((semantic) => ({
    value: semantic,
    label: t(`data.semantics.${semantic}`),
  }))

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        {dataset ? null : (
          <Field label={t('data.import.mapping.datasetName')} required>
            <Input
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              aria-label={t('data.import.mapping.datasetName')}
            />
          </Field>
        )}
        {dataset ? (
          <ChoiceSelect
            label={t('data.import.mapping.mode')}
            value={mode}
            onChange={onModeChange}
            options={MODES.map((value) => ({
              value,
              label: t(`data.import.mapping.modes.${value}`),
            }))}
          />
        ) : null}
      </div>

      {geometry ? (
        <Switch checked={useGeometry} onCheckedChange={onUseGeometryChange} label={geometry} />
      ) : null}
      {supportsReview({ dataset, mode }) ? (
        <div className="flex flex-col gap-1">
          <Switch
            checked={review}
            onCheckedChange={onReviewChange}
            label={t('data.import.mapping.review')}
          />
          <p className="text-xs text-fg-muted">{t('data.import.mapping.reviewHint')}</p>
        </div>
      ) : null}

      <div className="overflow-auto rounded-md border border-line">
        <table className="min-w-full border-collapse text-xs">
          <thead className="bg-surface-2 text-fg-secondary">
            <tr>
              <th scope="col" className="w-8 px-2 py-1.5 text-left font-medium">
                <span className="sr-only">{t('data.import.mapping.include')}</span>
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('data.import.mapping.column')}
              </th>
              {dataset ? (
                <th scope="col" className="px-2 py-1.5 text-left font-medium">
                  {t('data.import.mapping.field')}
                </th>
              ) : (
                <>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">
                    {t('data.import.mapping.label')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">
                    {t('data.import.mapping.fieldKey')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">
                    {t('data.import.mapping.type')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">
                    {t('data.import.mapping.semantic')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-center font-medium">
                    {t('data.import.mapping.key')}
                  </th>
                </>
              )}
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('data.import.mapping.samples')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const column = columns.get(row.column)
              return (
                <tr key={row.column} className="border-t border-line align-top">
                  <td className="px-2 py-1.5">
                    <Checkbox
                      checked={row.include}
                      onCheckedChange={(checked) => update(index, { include: checked === true })}
                      aria-label={`${t('data.import.mapping.include')}: ${row.name}`}
                      disabled={Boolean(dataset) && !row.fieldKey}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="block font-medium text-fg">{row.name}</span>
                    {column ? (
                      <span className="block text-2xs text-fg-muted">
                        {column.invalid > 0 ? (
                          <span className="text-warning">
                            {t('data.import.mapping.invalid', { count: column.invalid })}
                          </span>
                        ) : column.unique ? (
                          t('data.import.mapping.unique')
                        ) : (
                          t('data.import.mapping.empty', {
                            percent: formatPercent(column.emptyShare, {}, { locale }),
                          })
                        )}
                      </span>
                    ) : null}
                  </td>
                  {dataset ? (
                    <td className="px-2 py-1.5">
                      <Select
                        value={row.fieldKey || SKIP}
                        onValueChange={(next) => {
                          const field = fields.find((item) => item.key === next)
                          update(
                            index,
                            field
                              ? {
                                  include: true,
                                  fieldKey: field.key,
                                  label: field.label.ru ?? field.key,
                                  type: field.type as ImportFieldType,
                                  semantic: field.semantic,
                                  ...(field.format ? { format: field.format } : {}),
                                }
                              : { include: false, fieldKey: '' },
                          )
                        }}
                      >
                        <SelectTrigger
                          aria-label={`${t('data.import.mapping.field')}: ${row.name}`}
                          className="h-7 min-w-[200px] text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SKIP}>{t('data.import.mapping.skip')}</SelectItem>
                          {fields.map((field) => (
                            <SelectItem key={field.key} value={field.key}>
                              {field.label.ru ?? field.key} · {t(`data.types.${field.type}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  ) : (
                    <>
                      <td className="px-2 py-1.5">
                        <Input
                          value={row.label}
                          onChange={(event) => update(index, { label: event.target.value })}
                          aria-label={`${t('data.import.mapping.label')}: ${row.name}`}
                          className="h-7 min-w-[160px] text-xs"
                          disabled={!row.include}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          mono
                          value={row.fieldKey}
                          onChange={(event) => update(index, { fieldKey: event.target.value })}
                          aria-label={`${t('data.import.mapping.fieldKey')}: ${row.name}`}
                          className="h-7 min-w-[140px]"
                          disabled={!row.include}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <CompactSelect
                          label={`${t('data.import.mapping.type')}: ${row.name}`}
                          value={row.type}
                          options={typeOptions}
                          disabled={!row.include}
                          onChange={(type) => update(index, { type, format: undefined })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <CompactSelect
                          label={`${t('data.import.mapping.semantic')}: ${row.name}`}
                          value={row.semantic}
                          options={semanticOptions}
                          disabled={!row.include}
                          onChange={(semantic: FieldSemantic) => update(index, { semantic })}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <Checkbox
                          checked={row.key}
                          disabled={!row.include}
                          onCheckedChange={(checked) => update(index, { key: checked === true })}
                          aria-label={`${t('data.import.mapping.key')}: ${row.name}`}
                        />
                      </td>
                    </>
                  )}
                  <td className="max-w-[220px] px-2 py-1.5 text-fg-secondary">
                    <span className="line-clamp-2 break-all">
                      {(column?.samples ?? []).join(' · ')}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {problems.length > 0 ? (
        <Callout tone="warning">
          <ul className="list-disc pl-4">
            {problems.map((problem) => (
              <li key={JSON.stringify(problem)}>{problemText(t, problem)}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </div>
  )
}

function CompactSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger aria-label={label} className="h-7 min-w-[130px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
