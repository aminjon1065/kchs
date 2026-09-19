import {
  type DatasetRecord,
  type FieldSemantic,
  IMPORT_CRS_PRESETS,
  IMPORT_FIELD_TYPES,
  IMPORT_LAYER_FORMATS,
  IMPORT_LIMITS,
  type ImportAnalysis,
  type ImportFieldType,
  type ImportMode,
  type ImportOptions,
  type ImportRecord,
} from '@kchs/contracts'
import { formatNumber, formatPercent } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  FileDropzone,
  Input,
  KeyValueList,
  ProgressBar,
  RadioGroup,
  RadioItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  Spinner,
  Stepper,
  Switch,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, XCircle } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { uploadFile } from '~/features/files/upload.js'
import { ApiError, http } from '~/shared/api/client.js'
import { PICKABLE_SEMANTICS } from './field-types.js'
import {
  buildRunInput,
  defaultDatasetName,
  importableFields,
  type MappingProblem,
  type MappingRow,
  mappingProblems,
  needsCrs,
  optionsFrom,
  rowsFrom,
  supportsReview,
} from './import-mapping.js'
import { ImportChanges } from './import-review.js'
import { dataKeys, importQuery, isImportFinished } from './queries.js'

const STEPS = ['file', 'structure', 'mapping', 'review'] as const
const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.json,.ndjson,.geojson,.zip,.gpkg,.kml,.kmz,.gpx'
/** Форматы без строк заголовка: столбцы — ключи объектов или поля слоя. */
const RECORD_FORMATS = new Set<string>(['json', 'ndjson', 'geojson', ...IMPORT_LAYER_FORMATS])
const CRS_OTHER = '__other'
const CRS_CODE = /^EPSG:\d{4,6}$/
const DELIMITERS = [
  { value: ',', key: 'comma' },
  { value: ';', key: 'semicolon' },
  { value: '\t', key: 'tab' },
  { value: '|', key: 'pipe' },
] as const
const ENCODINGS = ['utf-8', 'windows-1251', 'cp866', 'koi8-r', 'utf-16']
const MODES: ImportMode[] = ['append', 'upsert', 'sync', 'replace']
const SKIP = '__skip'

export interface ImportWizardProps {
  onClose: () => void
  /** Пространство нового датасета и загружаемого файла. */
  spaceId: string
  /** Файл, брошенный в каталог, — мастер сразу начинает с его загрузки. */
  initialFile?: File | null
  /** Импорт в существующий датасет (из его экрана). */
  dataset?: DatasetRecord
}

/**
 * Мастер импорта (03-screens.md §6): Файл → Структура → Сопоставление →
 * Проверка и запуск; затем ход выполнения и итог с кнопкой «Открыть».
 */
export function ImportWizard({ onClose, spaceId, initialFile, dataset }: ImportWizardProps) {
  const t = useT()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)

  const [step, setStep] = useState(0)
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null)
  const [options, setOptions] = useState<ImportOptions>({})
  const [rows, setRows] = useState<MappingRow[]>([])
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ImportMode>(dataset ? 'append' : 'replace')
  const [useGeometry, setUseGeometry] = useState(true)
  const [review, setReview] = useState(true)
  const [onError, setOnError] = useState<'skip' | 'stop'>('skip')
  const [importId, setImportId] = useState<string | null>(null)

  const analyze = useMutation({
    mutationFn: (input: { fileId: string; options: ImportOptions }) =>
      http.post<ImportAnalysis>('/datasets/imports/analyze', input),
    onSuccess: (result) => {
      setFailure(null)
      setAnalysis(result)
      setOptions(optionsFrom(result))
      setRows(rowsFrom(result, dataset))
      setStep((current) => Math.max(current, 1))
    },
    onError: (error) =>
      setFailure(error instanceof ApiError ? error.message : t('data.import.file.analyzeFailed')),
  })

  const takeFile = async (picked: File): Promise<void> => {
    if (picked.size > IMPORT_LIMITS.maxFileBytes) {
      setFailure(t('data.import.file.tooLarge'))
      return
    }
    setFailure(null)
    setProgress(0)
    try {
      const uploaded = await uploadFile({ file: picked, spaceId, onProgress: setProgress })
      setFile({ id: uploaded.id, name: picked.name })
      setName((current) => current || defaultDatasetName(picked.name))
      analyze.mutate({ fileId: uploaded.id, options: {} })
    } catch {
      setFailure(t('data.import.file.uploadFailed'))
    } finally {
      setProgress(null)
    }
  }

  // Файл из каталога загружается один раз, при открытии мастера
  const initialTaken = useRef(false)
  useEffect(() => {
    if (initialFile && !initialTaken.current) {
      initialTaken.current = true
      void takeFile(initialFile)
    }
  })

  const start = useMutation({
    mutationFn: () => {
      if (!file || !analysis) throw new Error(t('data.import.file.analyzeFailed'))
      return http.post<ImportRecord>(
        '/datasets/imports',
        buildRunInput({
          fileId: file.id,
          options,
          rows,
          target: { dataset, name, mode, spaceId },
          geometry: useGeometry ? analysis.geometry : null,
          onError,
          review,
        }),
      )
    },
    onSuccess: (record) => {
      setFailure(null)
      setImportId(record.id)
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const problems = useMemo(
    () => mappingProblems(rows, { dataset, name, mode }),
    [rows, dataset, name, mode],
  )

  const title = dataset
    ? t('data.import.titleInto', { name: dataset.name })
    : t('data.import.title')

  // Геометрия в метрах без системы координат не загрузится — сначала выбрать систему
  const canNext =
    (step === 0 && Boolean(analysis)) ||
    (step === 1 && Boolean(analysis) && !analyze.isPending && !(analysis && needsCrs(analysis))) ||
    (step === 2 && problems.length === 0)
  const reviewing = review && supportsReview({ dataset, mode })

  const footer = importId ? null : (
    <>
      {step > 0 ? (
        <Button variant="ghost" onClick={() => setStep(step - 1)} className="mr-auto">
          {t('data.import.back')}
        </Button>
      ) : null}
      <Button variant="secondary" onClick={onClose}>
        {t('common.actions.cancel')}
      </Button>
      {step < 3 ? (
        <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
          {t('data.import.next')}
        </Button>
      ) : (
        <Button
          variant="primary"
          loading={start.isPending}
          disabled={problems.length > 0}
          onClick={() => start.mutate()}
        >
          {t(reviewing ? 'data.import.review.startReview' : 'data.import.review.start')}
        </Button>
      )}
    </>
  )

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={title} width="min(960px, 100vw)" footer={footer}>
        {importId ? (
          <ImportProgress
            importId={importId}
            dataset={dataset}
            onOpen={(datasetId) => {
              openTab({
                kind: 'object',
                objectId: datasetId,
                objectType: 'dataset',
                title: dataset?.name ?? name,
                mode: 'permanent',
              })
              onClose()
            }}
            onClose={onClose}
            onFinished={(record) => {
              void client.invalidateQueries({ queryKey: ['objects'] })
              void client.invalidateQueries({ queryKey: dataKeys.dataset(record.datasetId) })
            }}
          />
        ) : (
          <div className="flex flex-col gap-5">
            <Stepper
              aria-label={t('data.import.steps.label')}
              steps={STEPS.map((key, index) => ({
                key,
                label: t(`data.import.steps.${key}`),
                description: index === 0 && file ? file.name : undefined,
              }))}
              current={step}
              onStepClick={setStep}
            />
            {failure ? <Callout tone="danger">{failure}</Callout> : null}
            {step === 0 ? (
              <FileStep
                progress={progress}
                analyzing={analyze.isPending}
                fileName={file?.name}
                onFile={(picked) => void takeFile(picked)}
              />
            ) : null}
            {step === 1 && analysis ? (
              <StructureStep
                analysis={analysis}
                options={options}
                onOptionsChange={setOptions}
                analyzing={analyze.isPending}
                onApply={() => file && analyze.mutate({ fileId: file.id, options })}
              />
            ) : null}
            {step === 2 && analysis ? (
              <MappingStep
                analysis={analysis}
                rows={rows}
                onRowsChange={setRows}
                dataset={dataset}
                name={name}
                onNameChange={setName}
                mode={mode}
                onModeChange={setMode}
                useGeometry={useGeometry}
                onUseGeometryChange={setUseGeometry}
                review={review}
                onReviewChange={setReview}
                problems={problems}
              />
            ) : null}
            {step === 3 && analysis && file ? (
              <ReviewStep
                analysis={analysis}
                rows={rows}
                fileName={file.name}
                dataset={dataset}
                name={name}
                mode={mode}
                review={reviewing}
                onError={onError}
                onOnErrorChange={setOnError}
              />
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ─── Шаг 1. Файл ─────────────────────────────────────────────────────────────

function FileStep({
  progress,
  analyzing,
  fileName,
  onFile,
}: {
  progress: number | null
  analyzing: boolean
  fileName?: string
  onFile: (file: File) => void
}) {
  const t = useT()
  if (progress !== null) {
    return (
      <div className="flex flex-col gap-2 py-8">
        <span className="text-sm text-fg-secondary">
          {t('data.import.file.uploading', { name: fileName ?? '' })}
        </span>
        <ProgressBar value={progress} showValue />
      </div>
    )
  }
  if (analyzing) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-fg-secondary">
        <Spinner />
        {t('data.import.file.analyzing')}
      </div>
    )
  }
  return (
    <FileDropzone
      multiple={false}
      accept={ACCEPT}
      onFiles={(files) => files[0] && onFile(files[0])}
      label={t('data.catalog.emptyHint')}
      hint={t('data.catalog.formats')}
    />
  )
}

// ─── Шаг 2. Структура ────────────────────────────────────────────────────────

function ChoiceSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T | undefined
  onChange: (value: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger aria-label={label}>
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
    </Field>
  )
}

function StructureStep({
  analysis,
  options,
  onOptionsChange,
  analyzing,
  onApply,
}: {
  analysis: ImportAnalysis
  options: ImportOptions
  onOptionsChange: (options: ImportOptions) => void
  analyzing: boolean
  onApply: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const set = (patch: Partial<ImportOptions>) => onOptionsChange({ ...options, ...patch })
  const isText = ['csv', 'tsv'].includes(analysis.format)
  const isBook = ['xlsx', 'xls'].includes(analysis.format)
  // Кодировку выбирают у текстовых файлов и у Shapefile (атрибуты DBF)
  const hasEncoding = isText || analysis.format === 'shp'
  const isRecords = RECORD_FORMATS.has(analysis.format)
  const geo = analysis.geo
  const changed = JSON.stringify(options) !== JSON.stringify(optionsFrom(analysis))
  const encodings = [...new Set([...ENCODINGS, ...(analysis.encoding ? [analysis.encoding] : [])])]
  const rowsLabel = t(
    analysis.approx ? 'data.import.structure.rowsApprox' : 'data.import.structure.rows',
    {
      count: analysis.rowEstimate,
    },
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
        <Badge tone="accent">{analysis.format.toUpperCase()}</Badge>
        <span>{rowsLabel}</span>
        <span aria-hidden>·</span>
        <span>{t('data.import.structure.columns', { count: analysis.columns.length })}</span>
        {geo && analysis.geometry ? (
          <>
            <span aria-hidden>·</span>
            <span>
              {t('data.import.structure.geometry', {
                type: t(`data.import.geometryTypes.${geometryTypeKey(geo.geometryType)}`),
              })}
            </span>
          </>
        ) : null}
        {geo?.bbox ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular">
              {t('data.import.structure.extent', {
                west: formatNumber(geo.bbox[0] ?? 0, { precision: 3 }, { locale }),
                south: formatNumber(geo.bbox[1] ?? 0, { precision: 3 }, { locale }),
                east: formatNumber(geo.bbox[2] ?? 0, { precision: 3 }, { locale }),
                north: formatNumber(geo.bbox[3] ?? 0, { precision: 3 }, { locale }),
              })}
            </span>
          </>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {geo && geo.layers.length > 1 ? (
          <ChoiceSelect
            label={t('data.import.structure.layer')}
            value={options.layer ?? geo.layer ?? undefined}
            onChange={(layer) => set({ layer })}
            options={geo.layers.map((layer) => ({
              value: layer.name,
              label: `${layer.name} (${formatNumber(layer.rows, {}, { locale })})`,
            }))}
          />
        ) : null}
        {geo ? (
          <CrsChoice
            value={options.crs ?? geo.crs ?? undefined}
            detected={geo.crs}
            detectedName={geo.crsName}
            source={geo.crsSource}
            onChange={(crs) => set({ crs })}
          />
        ) : null}
        {isBook && analysis.sheets.length > 0 ? (
          <ChoiceSelect
            label={t('data.import.structure.sheet')}
            value={options.sheet ?? analysis.sheet ?? undefined}
            onChange={(sheet) => set({ sheet })}
            options={analysis.sheets.map((sheet) => ({
              value: sheet.name,
              label: `${sheet.name} (${formatNumber(sheet.rows, {}, { locale })})`,
            }))}
          />
        ) : null}
        {hasEncoding ? (
          <ChoiceSelect
            label={t('data.import.structure.encoding')}
            value={options.encoding}
            onChange={(encoding) => set({ encoding })}
            options={encodings.map((value) => ({ value, label: value.toUpperCase() }))}
          />
        ) : null}
        {isText ? (
          <ChoiceSelect
            label={t('data.import.structure.delimiter')}
            value={options.delimiter}
            onChange={(delimiter) => set({ delimiter })}
            options={DELIMITERS.map((item) => ({
              value: item.value,
              label: t(`data.import.structure.delimiters.${item.key}`),
            }))}
          />
        ) : null}
        {isRecords ? null : (
          <>
            <Field label={t('data.import.structure.skipRows')}>
              <Input
                type="number"
                min={0}
                max={1000}
                value={options.skipRows ?? 0}
                onChange={(event) => set({ skipRows: clampInt(event.target.value, 0, 1000) })}
                aria-label={t('data.import.structure.skipRows')}
              />
            </Field>
            <Field label={t('data.import.structure.headerRows')}>
              <Input
                type="number"
                min={0}
                max={5}
                value={options.headerRows ?? 1}
                onChange={(event) => set({ headerRows: clampInt(event.target.value, 0, 5) })}
                aria-label={t('data.import.structure.headerRows')}
              />
            </Field>
          </>
        )}
        <ChoiceSelect
          label={t('data.import.structure.decimal')}
          value={options.decimal}
          onChange={(decimal) => set({ decimal })}
          options={[
            { value: '.', label: '1234.5' },
            { value: ',', label: '1234,5' },
          ]}
        />
        <ChoiceSelect
          label={t('data.import.structure.dateOrder')}
          value={options.dateOrder}
          onChange={(dateOrder) => set({ dateOrder })}
          options={(['dmy', 'mdy', 'ymd'] as const).map((value) => ({
            value,
            label: t(`data.import.structure.dateOrders.${value}`),
          }))}
        />
      </div>

      {changed ? (
        <div>
          <Button variant="subtle" size="sm" loading={analyzing} onClick={onApply}>
            {t('data.import.structure.apply')}
          </Button>
        </div>
      ) : null}

      {needsCrs(analysis) ? (
        <Callout tone="danger">{t('data.import.structure.crsRequired')}</Callout>
      ) : null}

      {analysis.warnings.length > 0 ? (
        <Callout tone="warning">
          <ul className="list-disc pl-4">
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <section aria-label={t('data.import.structure.preview')} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-fg-secondary">
          {t('data.import.structure.preview')}
        </h3>
        <div className="max-h-[360px] overflow-auto rounded-md border border-line">
          <table className="min-w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                {analysis.columns.map((column) => (
                  <th
                    key={column.index}
                    scope="col"
                    className="border-b border-line px-2 py-1.5 text-left font-medium whitespace-nowrap text-fg-secondary"
                  >
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {analysis.preview.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-line last:border-b-0">
                  {analysis.columns.map((column) => (
                    <td
                      key={column.index}
                      className="max-w-[240px] truncate px-2 py-1 whitespace-nowrap text-fg"
                    >
                      {row[column.index] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

/** Ключ названия типа геометрии: известные типы — по имени, разные и прочие — «разные». */
function geometryTypeKey(type: string | null): string {
  const known = [
    'Point',
    'MultiPoint',
    'LineString',
    'MultiLineString',
    'Polygon',
    'MultiPolygon',
    'GeometryCollection',
  ]
  return type && known.includes(type) ? type : 'mixed'
}

/**
 * Система координат исходных данных: частые системы, определённая в файле и
 * «другая» по коду EPSG. Выбор применяется повторным анализом («Применить»).
 */
function CrsChoice({
  value,
  detected,
  detectedName,
  source,
  onChange,
}: {
  value: string | undefined
  detected: string | null
  detectedName: string | null
  source: NonNullable<ImportAnalysis['geo']>['crsSource']
  onChange: (crs: string) => void
}) {
  const t = useT()
  const presets: string[] = [...IMPORT_CRS_PRESETS]
  const [custom, setCustom] = useState(
    value !== undefined && !presets.includes(value) && value !== detected,
  )
  const [code, setCode] = useState(custom ? (value ?? '') : '')
  const label = `${t('data.import.structure.crs')} · ${t(`data.import.structure.crsSources.${source}`)}`
  const presetLabel = (crs: string) =>
    (presets as string[]).includes(crs)
      ? t(`data.import.structure.crsPresets.${crs.replace('EPSG:', 'epsg')}`)
      : detectedName
        ? `${detectedName} (${crs})`
        : crs
  const known = detected && !presets.includes(detected) ? [detected, ...presets] : presets
  return (
    <div className="col-span-2 flex flex-col gap-2">
      <Field label={label}>
        <Select
          value={custom ? CRS_OTHER : value}
          onValueChange={(next) => {
            if (next === CRS_OTHER) {
              setCustom(true)
              return
            }
            setCustom(false)
            onChange(next)
          }}
        >
          <SelectTrigger aria-label={t('data.import.structure.crs')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {known.map((crs) => (
              <SelectItem key={crs} value={crs}>
                {presetLabel(crs)}
              </SelectItem>
            ))}
            <SelectItem value={CRS_OTHER}>{t('data.import.structure.crsPresets.other')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {custom ? (
        <Field
          label={t('data.import.structure.crsCode')}
          hint={t('data.import.structure.crsCodeHint')}
        >
          <Input
            mono
            value={code}
            onChange={(event) => {
              const next = event.target.value.trim().toUpperCase()
              setCode(next)
              if (CRS_CODE.test(next)) onChange(next)
            }}
            aria-label={t('data.import.structure.crsCode')}
          />
        </Field>
      ) : null}
    </div>
  )
}

function clampInt(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}

// ─── Шаг 3. Сопоставление ────────────────────────────────────────────────────

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

function MappingStep({
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
  const locale = useAppearance((s) => s.locale)
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

// ─── Шаг 4. Проверка и запуск ────────────────────────────────────────────────

function ReviewStep({
  analysis,
  rows,
  fileName,
  dataset,
  name,
  mode,
  review,
  onError,
  onOnErrorChange,
}: {
  analysis: ImportAnalysis
  rows: MappingRow[]
  fileName: string
  dataset?: DatasetRecord
  name: string
  mode: ImportMode
  review: boolean
  onError: 'skip' | 'stop'
  onOnErrorChange: (value: 'skip' | 'stop') => void
}) {
  const t = useT()
  const included = rows.filter((row) => row.include)
  const columns = new Map(analysis.columns.map((column) => [column.index, column]))
  const suspicious = included.filter((row) => (columns.get(row.column)?.invalid ?? 0) > 0)
  const key = dataset
    ? dataset.primaryKey
    : included.filter((row) => row.key).map((r) => r.fieldKey)

  return (
    <div className="flex flex-col gap-4">
      <KeyValueList
        items={[
          { key: 'file', label: t('data.import.review.file'), value: fileName },
          {
            key: 'target',
            label: t('data.import.review.target'),
            value: dataset
              ? `${t('data.import.review.existing', { name: dataset.name })} · ${t(`data.import.mapping.modes.${mode}`)}`
              : t('data.import.review.newDataset', { name: name.trim() }),
          },
          {
            key: 'rows',
            label: t('data.fields.rows'),
            value: t(
              analysis.approx ? 'data.import.structure.rowsApprox' : 'data.import.structure.rows',
              { count: analysis.rowEstimate },
            ),
          },
          {
            key: 'fields',
            label: t('data.import.review.fields'),
            value: included.map((row) => row.label || row.fieldKey).join(', '),
          },
          {
            key: 'key',
            label: t('data.import.review.key'),
            value: key.length > 0 ? key.join(', ') : t('data.import.review.noKey'),
          },
          ...(analysis.geo?.layer
            ? [{ key: 'layer', label: t('data.import.review.layer'), value: analysis.geo.layer }]
            : []),
          ...(analysis.geo?.crs && analysis.geometry
            ? [
                {
                  key: 'crs',
                  label: t('data.import.review.crs'),
                  value: analysis.geo.crsName
                    ? `${analysis.geo.crsName} (${analysis.geo.crs})`
                    : analysis.geo.crs,
                },
              ]
            : []),
          ...(review
            ? [
                {
                  key: 'changes',
                  label: t('data.import.review.changes'),
                  value: t('data.import.review.changesReview'),
                },
              ]
            : []),
        ]}
      />

      {suspicious.length > 0 ? (
        <Callout tone="warning" title={t('data.import.review.problems')}>
          <ul className="list-disc pl-4">
            {suspicious.map((row) => (
              <li key={row.column}>
                {row.name}:{' '}
                {t('data.import.mapping.invalid', { count: columns.get(row.column)?.invalid ?? 0 })}
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout tone="success">{t('data.import.review.noProblems')}</Callout>
      )}

      <Field label={t('data.import.review.onError')}>
        <RadioGroup
          value={onError}
          onValueChange={(value) => onOnErrorChange(value as 'skip' | 'stop')}
          className="flex flex-col gap-2"
        >
          <RadioItem value="skip" label={t('data.import.review.onErrorSkip')} />
          <RadioItem value="stop" label={t('data.import.review.onErrorStop')} />
        </RadioGroup>
      </Field>
    </div>
  )
}

// ─── Ход выполнения ──────────────────────────────────────────────────────────

function ImportProgress({
  importId,
  dataset,
  onOpen,
  onClose,
  onFinished,
}: {
  importId: string
  /** Существующий датасет: подписи полей и версия для сводки изменений. */
  dataset?: DatasetRecord
  onOpen: (datasetId: string) => void
  onClose: () => void
  onFinished: (record: ImportRecord) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: record } = useQuery(importQuery(importId))
  const finished = isImportFinished(record?.status)

  const reported = useRef(false)
  useEffect(() => {
    if (record && finished && !reported.current) {
      reported.current = true
      onFinished(record)
    }
  })

  if (!record) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }

  const number = (value: number) => formatNumber(value, {}, { locale })
  let body: ReactNode
  if (record.status === 'review') {
    body = (
      <ImportChanges
        record={record}
        fields={dataset?.fields}
        currentVersion={dataset?.currentVersion}
      />
    )
  } else if (record.status === 'cancelled') {
    body = (
      <div className="flex flex-col gap-4">
        <Callout tone="neutral">{t('data.import.progress.cancelled')}</Callout>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('data.import.progress.close')}
          </Button>
        </div>
      </div>
    )
  } else if (!finished) {
    body = (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Spinner />
        <p className="text-sm text-fg">{t(`data.import.progress.${record.status}`)}</p>
        <p className="text-xs text-fg-muted">{t('data.import.progress.background')}</p>
      </div>
    )
  } else {
    const ok = record.status === 'succeeded'
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {ok ? (
            <CheckCircle2 className="size-6 shrink-0 text-success" aria-hidden />
          ) : (
            <XCircle className="size-6 shrink-0 text-danger" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="text-md font-semibold text-fg">
              {t(ok ? 'data.import.progress.succeeded' : 'data.import.progress.failed')}
            </p>
            <p className="text-xs text-fg-secondary">
              {t('data.import.progress.stats', {
                inserted: number(record.stats.inserted),
                updated: number(record.stats.updated),
                deleted: number(record.stats.deleted),
                errors: number(record.stats.errors),
              })}
            </p>
          </div>
        </div>
        {record.errorSample.length > 0 ? (
          <section aria-label={t('data.import.progress.errors')} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-fg-secondary">
              {t('data.import.progress.errors')}
            </h3>
            <div className="max-h-[320px] overflow-auto rounded-md border border-line">
              <table className="min-w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-surface-2 text-fg-secondary">
                  <tr>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.progress.row')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.mapping.field')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.progress.value')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-left font-medium">
                      {t('data.import.progress.reason')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {record.errorSample.map((item) => (
                    <tr key={`${item.row}-${item.column}`} className="border-t border-line">
                      <td className="px-2 py-1 tabular text-fg">{number(item.row)}</td>
                      <td className="px-2 py-1 font-mono text-fg">{item.column}</td>
                      <td className="max-w-[200px] truncate px-2 py-1 text-fg">
                        {item.value ?? '—'}
                      </td>
                      <td className="px-2 py-1 text-fg-secondary">
                        {t(`data.import.errorCodes.${item.reason}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('data.import.progress.close')}
          </Button>
          {ok ? (
            <Button variant="primary" onClick={() => onOpen(record.datasetId)}>
              {t('data.import.progress.open')}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return body
}
