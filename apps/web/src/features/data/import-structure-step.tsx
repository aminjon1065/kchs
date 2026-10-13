import {
  IMPORT_CRS_PRESETS,
  IMPORT_LAYER_FORMATS,
  type ImportAnalysis,
  type ImportOptions,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { needsCrs, optionsFrom } from './import-mapping.js'

/** Шаг 2 мастера импорта (ADR-0046): лист, строка заголовка, разделитель, кодировка, геометрия и система координат. */

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
export function ChoiceSelect<T extends string>({
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

export function StructureStep({
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
  const locale = useLocale()
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
