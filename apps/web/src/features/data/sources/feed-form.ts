import type {
  DatasetFieldInput,
  FeedConfig,
  FeedConfigInput,
  FeedFormat,
  FeedPathInfo,
  FeedTransform,
  FeedValue,
  FeedValueMap,
} from '@kchs/contracts'

/**
 * Черновик настройки ленты по адресу (ADR-0132) — состояние мастера отдельно от
 * отрисовки: из настройки в черновик и обратно, поля нового датасета по путям
 * записей, ключ и проверка готовности шага.
 */

export const FEED_VALUE_KINDS = ['none', 'path', 'const', 'template', 'date_time'] as const
export type FeedValueKind = (typeof FEED_VALUE_KINDS)[number]

/** Откуда берётся значение одного поля датасета. */
export interface MappingDraft {
  kind: FeedValueKind
  path: string
  transform: FeedTransform
  constant: string
  template: string
  date: string
  time: string
  /**
   * Словарь значений пути (`EQ` → `earthquake`): мастер его не показывает, но и не
   * теряет — правка ленты, заведённой пакетом или из API, сохраняет словарь.
   */
  map?: FeedValueMap | undefined
}

/** Типы полей, которые мастер предлагает для нового датасета. */
export const NEW_FIELD_TYPES = [
  'identifier',
  'text',
  'long_text',
  'number',
  'integer',
  'datetime',
  'date',
  'boolean',
  'url',
] as const
export type NewFieldType = (typeof NEW_FIELD_TYPES)[number]

/** Поле нового датасета, заведённое по пути записи ленты. */
export interface NewFieldDraft {
  key: string
  label: string
  type: NewFieldType
}

export type GeometrySource = 'none' | 'feature' | 'latlon'

export interface FeedDraft {
  url: string
  format: FeedFormat
  itemsPath: string
  /** Интеграция HTTP с секретами; пусто — без неё. */
  integrationId: string
  geometry: GeometrySource
  lat: string
  lon: string
  geometryField: string
  territoryField: string
  withinTerritory: boolean
  /** Область отбора: запад, юг, восток, север — строками полей ввода; null — без неё. */
  bbox: [string, string, string, string] | null
  keyFields: string[]
  /** Поле датасета → откуда значение. */
  mapping: Record<string, MappingDraft>
}

/** Область Таджикистана с запасом по границе — пресет отбора лент мировых служб. */
export const TAJIKISTAN_BBOX: [number, number, number, number] = [67.3, 36.6, 75.2, 41.1]

/** Поле нового датасета для геометрии и района — ключи по умолчанию. */
export const NEW_GEOMETRY_FIELD = 'geometry'
export const NEW_TERRITORY_FIELD = 'district'

export function emptyMapping(): MappingDraft {
  return {
    kind: 'none',
    path: '',
    transform: 'auto',
    constant: '',
    template: '',
    date: '',
    time: '',
  }
}

export function emptyDraft(): FeedDraft {
  return {
    url: '',
    format: 'geojson',
    itemsPath: '',
    integrationId: '',
    geometry: 'none',
    lat: '',
    lon: '',
    geometryField: '',
    territoryField: '',
    withinTerritory: false,
    bbox: null,
    keyFields: [],
    mapping: {},
  }
}

function mappingOf(value: FeedValue): MappingDraft {
  const draft = emptyMapping()
  switch (value.kind) {
    case 'path':
      return {
        ...draft,
        kind: 'path',
        path: value.path,
        transform: value.transform,
        ...(value.map ? { map: value.map } : {}),
      }
    case 'const':
      return { ...draft, kind: 'const', constant: String(value.value) }
    case 'template':
      return { ...draft, kind: 'template', template: value.template }
    default:
      return { ...draft, kind: 'date_time', date: value.date, time: value.time }
  }
}

/** Черновик по сохранённой настройке ленты — для правки. */
export function draftFromConfig(config: FeedConfig, integrationId: string | null): FeedDraft {
  return {
    url: config.url,
    format: config.format,
    itemsPath: config.itemsPath ?? '',
    integrationId: integrationId ?? '',
    geometry: config.geometry?.kind ?? 'none',
    lat: config.geometry?.kind === 'latlon' ? config.geometry.lat : '',
    lon: config.geometry?.kind === 'latlon' ? config.geometry.lon : '',
    geometryField: config.geometryField ?? '',
    territoryField: config.territoryField ?? '',
    withinTerritory: config.withinTerritory,
    bbox: config.bbox ? (config.bbox.map(String) as FeedDraft['bbox']) : null,
    keyFields: config.keyFields,
    mapping: Object.fromEntries(config.mapping.map((item) => [item.field, mappingOf(item.value)])),
  }
}

/** Значение сопоставления; поле без источника или с пустым вводом — не сопоставлено. */
function resolvedValue(draft: MappingDraft): FeedValue | null {
  switch (draft.kind) {
    case 'path':
      return draft.path
        ? {
            kind: 'path',
            path: draft.path,
            transform: draft.transform,
            ...(draft.map ? { map: draft.map } : {}),
          }
        : null
    case 'const': {
      if (draft.constant.trim() === '') return null
      return { kind: 'const', value: draft.constant.trim() }
    }
    case 'template':
      return draft.template.trim() ? { kind: 'template', template: draft.template.trim() } : null
    case 'date_time':
      return draft.date && draft.time
        ? { kind: 'date_time', date: draft.date, time: draft.time }
        : null
    default:
      return null
  }
}

/** Поля, которые заполняет лента по сопоставлению. */
export function mappedFields(draft: FeedDraft): string[] {
  return Object.entries(draft.mapping)
    .filter(([, value]) => resolvedValue(value) !== null)
    .map(([field]) => field)
}

function bboxOf(draft: FeedDraft): FeedConfigInput['bbox'] {
  if (!draft.bbox) return null
  const numbers = draft.bbox.map((value) => Number(value.replace(',', '.')))
  return numbers.every((value) => Number.isFinite(value))
    ? (numbers as [number, number, number, number])
    : null
}

/** Настройка ленты для API по черновику. */
export function configFromDraft(draft: FeedDraft): FeedConfigInput {
  const mapping = Object.entries(draft.mapping).flatMap(([field, value]) => {
    const resolved = resolvedValue(value)
    return resolved ? [{ field, value: resolved }] : []
  })
  const geometry: FeedConfigInput['geometry'] =
    draft.geometry === 'feature'
      ? { kind: 'feature' }
      : draft.geometry === 'latlon'
        ? { kind: 'latlon', lat: draft.lat, lon: draft.lon }
        : null
  const located = geometry !== null
  return {
    url: draft.url.trim(),
    format: draft.format,
    itemsPath: draft.format === 'json' && draft.itemsPath.trim() ? draft.itemsPath.trim() : null,
    bbox: located ? bboxOf(draft) : null,
    withinTerritory: located && draft.withinTerritory,
    mapping,
    geometry,
    geometryField: located && draft.geometryField ? draft.geometryField : null,
    territoryField: located && draft.territoryField ? draft.territoryField : null,
    keyFields: draft.keyFields.filter((key) => mapping.some((item) => item.field === key)),
  }
}

/** Ключ поля по пути записи: последняя часть пути латиницей в snake_case. */
export function keyFromPath(path: string, taken: ReadonlySet<string> = new Set()): string {
  const last =
    path
      .split('.')
      .filter((part) => !/^\d+$/.test(part))
      .at(-1) ?? path
  let base = last
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!base || !/^[a-z_]/.test(base)) base = `field_${base}`.replace(/_+$/, '')
  base = base.slice(0, 50)
  let key = base
  for (let index = 2; taken.has(key); index++) key = `${base}_${index}`
  return key
}

/** Тип поля нового датасета по типу значений пути. */
export function typeFromPath(info: Pick<FeedPathInfo, 'type'>): NewFieldType {
  switch (info.type) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'datetime':
      return 'datetime'
    default:
      return 'text'
  }
}

/** Подпись поля по пути: последняя часть без номеров элементов (`properties.mag` → `mag`). */
export function labelFromPath(path: string): string {
  return (
    path
      .split('.')
      .filter((part) => !/^\d+$/.test(part))
      .at(-1) ?? path
  )
}

/** Поля нового датасета для выбранных путей: ключ, подпись и тип. */
export function newFieldsFor(paths: readonly FeedPathInfo[]): NewFieldDraft[] {
  const taken = new Set([NEW_GEOMETRY_FIELD, NEW_TERRITORY_FIELD])
  return paths.map((info) => {
    const key = keyFromPath(info.path, taken)
    taken.add(key)
    return { key, label: labelFromPath(info.path), type: typeFromPath(info) }
  })
}

/** Определения полей нового датасета: выбранные пути, геометрия и район. */
export function datasetFields(
  fields: readonly NewFieldDraft[],
  keyFields: readonly string[],
  draft: Pick<FeedDraft, 'geometryField' | 'territoryField'>,
): DatasetFieldInput[] {
  const defs: DatasetFieldInput[] = fields.map((field, index) => ({
    key: field.key,
    label: { ru: field.label.trim() || field.key },
    type: field.type,
    semantic:
      field.type === 'number' || field.type === 'integer'
        ? 'measure'
        : field.type === 'datetime' || field.type === 'date'
          ? 'time'
          : field.type === 'identifier'
            ? 'identifier'
            : 'dimension',
    required: keyFields.includes(field.key),
    unique: false,
    indexed: keyFields.includes(field.key),
    sensitive: false,
    readOnly: false,
    nullable: !keyFields.includes(field.key),
    order: index,
  }))
  if (draft.geometryField) {
    defs.push({
      key: draft.geometryField,
      // i18n-ignore: подпись поля по умолчанию — данные датасета на двух языках, а не текст интерфейса
      label: { ru: 'Геометрия', en: 'Geometry' },
      type: 'geometry',
      semantic: 'geometry',
      required: false,
      unique: false,
      indexed: false,
      sensitive: false,
      readOnly: false,
      nullable: true,
      order: defs.length,
    })
  }
  if (draft.territoryField) {
    defs.push({
      key: draft.territoryField,
      // i18n-ignore: подпись поля по умолчанию — данные датасета на двух языках, а не текст интерфейса
      label: { ru: 'Район', en: 'District' },
      type: 'territory',
      semantic: 'territory',
      required: false,
      unique: false,
      indexed: true,
      sensitive: false,
      readOnly: false,
      nullable: true,
      order: defs.length,
    })
  }
  return defs
}

/** Что мешает сохранить ленту; пусто — можно сохранять. */
export function draftProblems(draft: FeedDraft): Array<'url' | 'mapping' | 'key' | 'geometry'> {
  const problems: Array<'url' | 'mapping' | 'key' | 'geometry'> = []
  if (!/^https?:\/\/\S+$/i.test(draft.url.trim())) problems.push('url')
  const config = configFromDraft(draft)
  if (config.mapping.length === 0) problems.push('mapping')
  if (config.keyFields.length === 0) problems.push('key')
  if (draft.geometry === 'latlon' && (!draft.lat || !draft.lon)) problems.push('geometry')
  return problems
}
