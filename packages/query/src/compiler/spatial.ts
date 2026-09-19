import {
  type FieldType,
  FilterNode,
  type LangText,
  type QuerySource,
  type QueryStep,
  SPATIAL_OPS,
  SYSTEM_DATASETS,
  TERRITORY_LEVELS,
  type TerritoryLevel,
} from '@kchs/contracts'
import { fail, type IssuePath } from '../errors.js'
import { isOrderable, VALUE_TYPE_LABELS, type ValueType } from '../value-types.js'
import { compileFilter, geometryLiteral } from './filter.js'
import {
  type Column,
  type ColumnMeta,
  columnSql,
  findColumn,
  type Relation,
  resolveColumn,
  uniqueInternal,
} from './scope.js'
import { type CompileState, MISSING } from './state.js'

type SpatialStep = Extract<QueryStep, { type: 'spatial' }>
type SpatialOp = SpatialStep['op']
type Predicate = 'intersects' | 'within' | 'contains' | 'dwithin'

/** Что шагу spatial нужно от конвейера (pipeline.ts) — без циклического импорта. */
export interface SpatialHost {
  readonly state: CompileState
  /** Текущее отношение конвейера. */
  readonly relation: Relation
  /**
   * Новое отношение после шага. `restructured` — строки другие (ячейки сетки,
   * растворение): порядок сбрасывается, режим таблицы не применяется — как у сводки.
   */
  update(relation: Relation, restructured: boolean): void
  /** Имя следующего CTE конвейера. */
  nextName(): string
  /** Источник цели с политиками смотрящего — как источник соединения. */
  source(source: QuerySource, path: IssuePath): Relation
}

/** Системный датасет справочника территорий: поля `id`, `code`, `level`, `geom` (ADR-0069). */
export const TERRITORIES_DATASET = 'territories'

/** Операции с целью: фильтры по отношению, ближайший, соединение, вырезание. */
const TARGET_OPS = new Set<SpatialOp>([
  'intersects',
  'within',
  'dwithin',
  'nearest',
  'spatial_join',
  'clip',
])

const PARAMS: Record<SpatialOp, readonly string[]> = {
  buffer: ['field', 'distance', 'distanceField'],
  intersects: ['field', 'negate'],
  within: ['field', 'negate'],
  dwithin: ['field', 'distance', 'negate'],
  nearest: ['field', 'limit', 'maxDistance', 'fields', 'as'],
  centroid: ['field', 'inside'],
  area: ['field', 'as'],
  length: ['field', 'as'],
  assign_territory: ['field', 'level', 'as'],
  spatial_join: ['field', 'predicate', 'distance', 'measures'],
  grid: ['field', 'size', 'measures'],
  hexgrid: ['field', 'size', 'measures'],
  dissolve: ['field', 'by', 'measures'],
  clip: ['field'],
}

const PREDICATES: readonly Predicate[] = ['intersects', 'within', 'contains', 'dwithin']
const MEASURE_AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const
type MeasureAgg = (typeof MEASURE_AGGS)[number]

/** Расстояние в метрах: до 1000 км (буфер, радиус, предел поиска ближайшего). */
const DISTANCE = { min: 0, max: 1_000_000, positive: true } as const
/** Сторона ячейки сетки, м: мельче 10 м сетка по данным региона не нужна и опасна по объёму. */
const CELL_SIZE = { min: 10, max: 1_000_000 } as const
const MAX_NEAREST = 100
const MAX_MEASURES = 50
const MAX_TERRITORIES = 1000
const NAME = /^[a-z_][a-z0-9_]*$/
const ALIAS = /^[a-z_][a-z0-9_]*$/i
const NUMERIC = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC_FIELD_TYPES = new Set<FieldType>([
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
])

/**
 * Подписи полей, которые добавляет шаг (результат и материализованный датасет).
 * Таджикский — с полным переводом (фаза 5), до него подпись берётся из ru.
 */
const LABELS = {
  area: { ru: 'Площадь, км²', en: 'Area, km²' },
  length: { ru: 'Длина, км', en: 'Length, km' },
  distance: { ru: 'Расстояние, м', en: 'Distance, m' },
  rank: { ru: 'Номер по близости', en: 'Nearest rank' },
  count: { ru: 'Количество', en: 'Count' },
  cell: { ru: 'Ячейка', en: 'Cell' },
} satisfies Record<string, LangText>

/** Подписи полей «территория уровня» (как уровни в справочнике территорий). */
const LEVEL_LABELS: Record<TerritoryLevel, LangText> = {
  country: { ru: 'Страна', en: 'Country' },
  region: { ru: 'Регион', en: 'Region' },
  district: { ru: 'Район', en: 'District' },
  jamoat: { ru: 'Джамоат', en: 'Jamoat' },
  settlement: { ru: 'Населённый пункт', en: 'Settlement' },
}

/**
 * Источники целей шага spatial — для `collectSources`: вызывающий загружает их
 * с политиками до компиляции. Без проверок формы: ошибки сообщит компиляция.
 */
export function spatialSources(step: SpatialStep): QuerySource[] {
  const sources: QuerySource[] = []
  if (step.op === 'assign_territory') sources.push({ kind: 'system', name: TERRITORIES_DATASET })
  const target = step.target
  if (!isRecord(target)) return sources
  if ((target.kind === 'dataset' || target.kind === 'query') && typeof target.id === 'string') {
    sources.push({ kind: target.kind, id: target.id })
  } else if (target.kind === 'system' && isSystemName(target.name)) {
    sources.push({ kind: 'system', name: target.name })
  } else if (target.kind === 'territory') {
    sources.push({ kind: 'system', name: TERRITORIES_DATASET })
  }
  return sources
}

/**
 * Шаг spatial (07-gis-engine.md §10, ADR-0069) → CTE на PostGIS. Метрические
 * величины — через geography (метры, км, км²), геометрии — WGS 84; цель —
 * датасет или сохранённый запрос с политиками смотрящего, справочник
 * территорий или геометрия GeoJSON; все значения — параметрами.
 */
export function compileSpatial(host: SpatialHost, step: SpatialStep, path: IssuePath): void {
  if (!(SPATIAL_OPS as readonly string[]).includes(step.op)) {
    fail([...path, 'op'], `Неизвестная пространственная операция «${String(step.op)}»`, {
      hint: `Допустимо: ${SPATIAL_OPS.join(', ')}`,
    })
  }
  const params: unknown = step.params ?? {}
  if (!isRecord(params)) fail([...path, 'params'], 'Параметры операции — объект')
  const hasTarget = step.target !== undefined && step.target !== null
  if (TARGET_OPS.has(step.op) && !hasTarget) {
    fail([...path, 'target'], `Для операции «${step.op}» нужна цель`, {
      hint: 'Датасет, сохранённый запрос, территории или геометрия GeoJSON',
    })
  }
  if (!TARGET_OPS.has(step.op) && hasTarget) {
    fail([...path, 'target'], `У операции «${step.op}» цели нет`)
  }
  new SpatialCompiler(host, step, params, path).compile()
}

type Target =
  | { kind: 'literal'; sql: string }
  | { kind: 'relation'; relation: Relation; geom: Column }

interface Measure {
  sql: string
  column: Column
}

class SpatialCompiler {
  private readonly params: ParamReader

  constructor(
    private readonly host: SpatialHost,
    private readonly step: SpatialStep,
    params: Record<string, unknown>,
    private readonly path: IssuePath,
  ) {
    this.params = new ParamReader(host.state, params, [...path, 'params'], PARAMS[step.op])
  }

  private get state(): CompileState {
    return this.host.state
  }

  private get d() {
    return this.host.state.dialect
  }

  private get rel(): Relation {
    return this.host.relation
  }

  private ident(name: string): string {
    return this.d.ident(name)
  }

  private ref(relation: Relation = this.rel): string {
    return this.d.ident(relation.name)
  }

  private col(column: Column, relation: Relation = this.rel): string {
    return columnSql(this.d, relation, column)
  }

  private geography(sql: string): string {
    return this.d.geography(sql)
  }

  private meters(value: number): string {
    return this.state.binder.add(value, 'double precision')
  }

  compile(): void {
    const op = this.step.op
    switch (op) {
      case 'buffer':
        this.buffer()
        break
      case 'centroid':
        this.centroid()
        break
      case 'area':
      case 'length':
        this.measureColumn(op)
        break
      case 'intersects':
      case 'within':
      case 'dwithin':
        this.predicate(op)
        break
      case 'nearest':
        this.nearest()
        break
      case 'assign_territory':
        this.assignTerritory()
        break
      case 'spatial_join':
        this.spatialJoin()
        break
      case 'grid':
      case 'hexgrid':
        this.grid(op)
        break
      case 'dissolve':
        this.dissolve()
        break
      case 'clip':
        this.clip()
        break
      default:
        fail([...this.path, 'op'], `Неизвестная пространственная операция «${String(op)}»`)
    }
  }

  // ─── Отношение ─────────────────────────────────────────────────────────────

  /** Новый CTE над текущим отношением с заданными столбцами. */
  private derive(body: string, columns: Column[], extra: Partial<Relation> = {}): void {
    const name = this.host.nextName()
    this.state.addCte(name, body)
    this.host.update({ ...this.rel, ...extra, name, columns }, false)
  }

  /** Отношение с новыми строками (ячейки, растворение): поля только результата. */
  private restructure(body: string, columns: Column[]): void {
    const name = this.host.nextName()
    this.state.addCte(name, body)
    this.host.update(
      { name, columns, restricted: new Map(), unavailable: new Map(), qualifiers: new Set() },
      true,
    )
  }

  /** Те же строки, значение одного столбца (геометрии) заменено выражением. */
  private replaceColumn(target: Column, sql: string): void {
    const select = this.rel.columns.map((column) =>
      column.internal === target.internal
        ? `${sql} AS ${this.ident(column.internal)}`
        : this.col(column),
    )
    this.derive(`SELECT ${select.join(', ')}\nFROM ${this.ref()}`, this.rel.columns)
  }

  /** Те же строки и добавленные столбцы. */
  private addColumns(select: string[], added: Column[]): void {
    this.derive(`SELECT ${this.ref()}.*, ${select.join(', ')}\nFROM ${this.ref()}`, [
      ...this.rel.columns,
      ...added,
    ])
  }

  /** Поле геометрии: `params.field` или единственное поле геометрии отношения. */
  private geometry(): Column {
    return geometryColumn(this.rel, this.params.string('field'), this.params.at('field'), 'данных')
  }

  /** Имя добавляемого поля: `params.as` или имя по умолчанию; не должно совпадать с полем. */
  private outputName(fallback: string): string {
    const value = this.params.string('as') ?? fallback
    if (!NAME.test(value) || value.length > 64) {
      fail(
        this.params.at('as'),
        'Имя поля — латиница в нижнем регистре, цифры и подчёркивание (до 64 символов)',
      )
    }
    if (this.rel.columns.some((column) => !column.hidden && column.name === value)) {
      fail(this.params.at('as'), `Поле «${value}» уже есть`, {
        hint: 'Задайте другое имя в params.as',
      })
    }
    return value
  }

  private column(
    name: string,
    internal: string,
    type: ValueType,
    meta: Partial<ColumnMeta> & { fieldType: FieldType },
  ): Column {
    return {
      name,
      qualifier: null,
      internal,
      type,
      meta: { semantic: null, label: null, format: null, ...meta },
      hidden: false,
    }
  }

  private taken(relation: Relation = this.rel): Set<string> {
    return new Set(relation.columns.map((column) => column.internal))
  }

  // ─── Цель ──────────────────────────────────────────────────────────────────

  /** Цель операции: геометрия-значение или отношение (датасет, запрос, территории). */
  private target(allowLiteral: boolean): Target {
    const path = [...this.path, 'target']
    const raw = this.step.target
    if (!isRecord(raw)) {
      return fail(path, 'Цель — датасет, сохранённый запрос, территории или геометрия GeoJSON')
    }
    // Геометрия GeoJSON без обёртки
    if (raw.kind === undefined && typeof raw.type === 'string') {
      return this.literal(raw, path, allowLiteral)
    }
    switch (raw.kind) {
      case 'geometry':
        allowedKeys(raw, ['kind', 'geometry'], path)
        return this.literal(raw.geometry, [...path, 'geometry'], allowLiteral)
      case 'dataset':
      case 'query':
      case 'system':
        return this.sourceTarget(raw, path)
      case 'territory':
        return this.territoryTarget(raw, path)
      default:
        return fail([...path, 'kind'], 'Вид цели — dataset, query, system, territory или geometry')
    }
  }

  private literal(value: unknown, path: IssuePath, allowed: boolean): Target {
    if (!allowed) {
      fail(path, `Для операции «${this.step.op}» цель — датасет, сохранённый запрос или территории`)
    }
    return { kind: 'literal', sql: geometryLiteral(this.state, value, path) }
  }

  /** Датасет, сохранённый запрос или системный датасет — с политиками, как в соединении. */
  private sourceTarget(raw: Record<string, unknown>, path: IssuePath): Target {
    const kind = raw.kind as 'dataset' | 'query' | 'system'
    allowedKeys(raw, ['kind', kind === 'system' ? 'name' : 'id', 'alias', 'field', 'filter'], path)
    const alias = raw.alias
    if (
      alias !== undefined &&
      (typeof alias !== 'string' || !ALIAS.test(alias) || alias.length > 32)
    ) {
      fail([...path, 'alias'], 'Алиас: латиница, цифры, подчёркивание (до 32 символов)')
    }
    const withAlias = typeof alias === 'string' ? { alias } : {}
    let source: QuerySource
    if (kind === 'system') {
      if (!isSystemName(raw.name)) {
        return fail([...path, 'name'], `Системный датасет — один из: ${SYSTEM_DATASETS.join(', ')}`)
      }
      source = { kind, name: raw.name, ...withAlias }
    } else {
      if (typeof raw.id !== 'string' || !UUID.test(raw.id)) {
        return fail([...path, 'id'], 'Нужен идентификатор источника')
      }
      source = { kind, id: raw.id, ...withAlias }
    }
    let relation = this.host.source(source, path)
    if (raw.filter !== undefined) relation = this.filterTarget(relation, raw.filter, path)
    const field = raw.field
    if (field !== undefined && typeof field !== 'string') {
      fail([...path, 'field'], 'Поле геометрии цели — строкой')
    }
    const geom = geometryColumn(relation, field, [...path, 'field'], 'цели')
    return { kind: 'relation', relation, geom }
  }

  /** Территории справочника: по идентификаторам и (или) уровню; граница — поле `geom`. */
  private territoryTarget(raw: Record<string, unknown>, path: IssuePath): Target {
    allowedKeys(raw, ['kind', 'id', 'ids', 'level'], path)
    if (raw.id !== undefined && raw.ids !== undefined) {
      fail([...path, 'ids'], 'Укажите id или ids, но не оба')
    }
    const idsPath = raw.id !== undefined ? [...path, 'id'] : [...path, 'ids']
    const list = raw.id !== undefined ? [raw.id] : raw.ids
    let ids: string[] | null = null
    if (list !== undefined) {
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TERRITORIES) {
        fail(idsPath, `Территории — непустой список идентификаторов (до ${MAX_TERRITORIES})`)
      }
      list.forEach((id, index) => {
        if (typeof id !== 'string' || !UUID.test(id)) {
          fail(
            raw.id !== undefined ? idsPath : [...idsPath, index],
            'Нужен идентификатор территории',
          )
        }
      })
      ids = list as string[]
    }
    const level = raw.level
    if (level !== undefined && !(TERRITORY_LEVELS as readonly unknown[]).includes(level)) {
      fail([...path, 'level'], `Уровень — один из: ${TERRITORY_LEVELS.join(', ')}`)
    }
    if (ids === null && level === undefined) {
      fail(path, 'Для цели-территорий нужны id, ids или level')
    }
    const conditions: FilterNode[] = []
    if (ids) conditions.push({ field: 'id', op: 'in', value: ids })
    if (level !== undefined) conditions.push({ field: 'level', op: 'eq', value: level })
    const relation = this.filterTarget(
      this.territories(path),
      conditions.length === 1 ? conditions[0] : { and: conditions },
      path,
    )
    return { kind: 'relation', relation, geom: directoryColumn(relation, 'geom', path) }
  }

  /** Справочник территорий — системный датасет с правами смотрящего. */
  private territories(path: IssuePath): Relation {
    return this.host.source({ kind: 'system', name: TERRITORIES_DATASET }, path)
  }

  /** Условие на цель — отдельным CTE над её источником. */
  private filterTarget(relation: Relation, raw: unknown, path: IssuePath): Relation {
    const parsed = FilterNode.safeParse(raw)
    if (!parsed.success) return fail([...path, 'filter'], 'Условие цели — в формате фильтра')
    const condition = compileFilter(
      this.state,
      parsed.data,
      {
        field: (ref, fieldPath) => {
          const column = resolveColumn(relation, ref, fieldPath)
          return {
            sql: columnSql(this.d, relation, column),
            type: column.type,
            fieldType: column.meta.fieldType,
          }
        },
      },
      [...path, 'filter'],
    )
    if (condition === null) return relation
    const name = this.state.nextName('j')
    this.state.addCte(name, `SELECT *\nFROM ${this.ref(relation)}\nWHERE ${condition}`)
    return { ...relation, name }
  }

  /** Пространственное отношение `a` к `b` (a — строка данных, b — цель). */
  private relate(predicate: Predicate, a: string, b: string, distance: string | null): string {
    switch (predicate) {
      case 'intersects':
        return `ST_Intersects(${a}, ${b})`
      case 'within':
        return `ST_Within(${a}, ${b})`
      case 'contains':
        return `ST_Contains(${a}, ${b})`
      case 'dwithin':
        return `ST_DWithin(${this.geography(a)}, ${this.geography(b)}, ${distance})`
    }
  }

  // ─── Операции ──────────────────────────────────────────────────────────────

  /** Буфер: геометрия заменяется зоной вокруг неё (метры, geography). */
  private buffer(): void {
    const geom = this.geometry()
    const hasDistance = this.params.has('distance')
    if (hasDistance === this.params.has('distanceField')) {
      fail(this.params.path, 'Для буфера нужно расстояние: distance (метры) или distanceField', {
        hint: 'distanceField — числовое поле с расстоянием в метрах',
      })
    }
    let radius: string
    if (hasDistance) {
      radius = this.meters(this.params.number('distance', DISTANCE, true))
    } else {
      const ref = this.params.string('distanceField') as string
      const column = resolveColumn(this.rel, ref, this.params.at('distanceField'))
      if (column.type !== 'number') {
        fail(
          this.params.at('distanceField'),
          `Расстояние буфера — число метров, а «${ref}» — ${VALUE_TYPE_LABELS[column.type]}`,
        )
      }
      radius = `(${this.col(column)})::double precision`
    }
    this.replaceColumn(geom, `ST_Buffer(${this.geography(this.col(geom))}, ${radius})::geometry`)
  }

  /** Центроид или точка на поверхности (`inside: true` — всегда внутри полигона). */
  private centroid(): void {
    const geom = this.geometry()
    const fn = this.params.boolean('inside') ? 'ST_PointOnSurface' : 'ST_Centroid'
    this.replaceColumn(geom, `${fn}(${this.col(geom)})`)
  }

  /** Площадь (км²) или длина (км) по geography — новым полем. */
  private measureColumn(kind: 'area' | 'length'): void {
    const geom = this.geometry()
    const name = this.outputName(kind === 'area' ? 'area_km2' : 'length_km')
    const g = this.geography(this.col(geom))
    const sql = kind === 'area' ? `(ST_Area(${g}) / 1000000.0)` : `(ST_Length(${g}) / 1000.0)`
    const internal = uniqueInternal(this.taken(), name)
    this.addColumns(
      [`${sql} AS ${this.ident(internal)}`],
      [
        this.column(name, internal, 'number', {
          fieldType: 'number',
          semantic: 'measure',
          label: LABELS[kind],
        }),
      ],
    )
  }

  /** Отбор строк по отношению к цели: пересекает, внутри, в радиусе (`negate` — наоборот). */
  private predicate(op: 'intersects' | 'within' | 'dwithin'): void {
    const geom = this.geometry()
    const negate = this.params.boolean('negate') ?? false
    const distance =
      op === 'dwithin' ? this.meters(this.params.number('distance', DISTANCE, true)) : null
    const target = this.target(true)
    const g = this.col(geom)
    let condition: string
    if (target.kind === 'literal') {
      condition = this.relate(op, g, target.sql, distance)
    } else {
      const { relation } = target
      const test = this.relate(op, g, this.col(target.geom, relation), distance)
      condition = `EXISTS (SELECT 1 FROM ${this.ref(relation)} WHERE ${test})`
    }
    // Строки без геометрии не относятся ни к какой цели — и в «не пересекает» не входят
    if (negate) condition = `${g} IS NOT NULL AND NOT ${condition}`
    this.derive(`SELECT *\nFROM ${this.ref()}\nWHERE ${condition}`, this.rel.columns)
  }

  /**
   * Ближайшие объекты цели: кандидаты — по KNN-индексу (`<->`), порядок и
   * расстояние (м) — по geography; поля цели добавляются к строке.
   */
  private nearest(): void {
    const geom = this.geometry()
    const k = this.params.integer('limit', 1, MAX_NEAREST) ?? 1
    const maxDistance = this.params.has('maxDistance')
      ? this.params.number('maxDistance', DISTANCE, true)
      : null
    const distanceName = this.outputName('distance_m')
    const target = this.target(true)
    const relation = this.rel
    const g = this.col(geom)
    const taken = this.taken()
    const distanceColumn = (internal: string) =>
      this.column(distanceName, internal, 'number', {
        fieldType: 'number',
        semantic: 'measure',
        label: LABELS.distance,
      })

    if (target.kind === 'literal') {
      for (const key of ['limit', 'maxDistance', 'fields']) {
        if (this.params.has(key)) {
          fail(this.params.at(key), `Для цели-геометрии параметр «${key}» не задаётся`, {
            hint: 'Результат — расстояние от каждой строки до геометрии',
          })
        }
      }
      const internal = uniqueInternal(taken, distanceName)
      this.addColumns(
        [
          `ST_Distance(${this.geography(g)}, ${this.geography(target.sql)}) AS ${this.ident(internal)}`,
        ],
        [distanceColumn(internal)],
      )
      return
    }

    const other = target.relation
    for (const qualifier of other.qualifiers) {
      if (relation.qualifiers.has(qualifier)) {
        fail([...this.path, 'target', 'alias'], `Алиас «${qualifier}» уже используется`, {
          hint: 'Задайте цели другой alias',
        })
      }
    }
    const requested = this.params.stringList('fields')
    const chosen = requested
      ? requested.map((ref, index) =>
          resolveColumn(other, ref, [...this.params.at('fields'), index]),
        )
      : other.columns.filter((column) => !column.hidden && column.type !== 'geometry')
    const prefix = [...other.qualifiers][0] ?? other.name
    const added: Column[] = []
    const inner: string[] = []
    for (const column of new Set(chosen)) {
      const internal = uniqueInternal(taken, column.internal, prefix)
      taken.add(internal)
      inner.push(`${this.col(column, other)} AS ${this.ident(internal)}`)
      added.push({ ...column, internal, hidden: false })
    }
    const tg = this.col(target.geom, other)
    const distanceInternal = uniqueInternal(taken, distanceName)
    taken.add(distanceInternal)
    inner.push(
      `ST_Distance(${this.geography(g)}, ${this.geography(tg)}) AS ${this.ident(distanceInternal)}`,
    )
    added.push(distanceColumn(distanceInternal))
    let rank = ''
    if (k > 1) {
      const rankInternal = uniqueInternal(taken, 'nearest_rank')
      taken.add(rankInternal)
      rank = `, row_number() OVER (ORDER BY ${this.ident('c')}.${this.ident(distanceInternal)}) AS ${this.ident(rankInternal)}`
      added.push(
        this.column('nearest_rank', rankInternal, 'number', {
          fieldType: 'integer',
          semantic: 'dimension',
          label: LABELS.rank,
        }),
      )
    }
    const where = [`${g} IS NOT NULL`, `${tg} IS NOT NULL`]
    if (maxDistance !== null) {
      where.push(
        `ST_DWithin(${this.geography(g)}, ${this.geography(tg)}, ${this.meters(maxDistance)})`,
      )
    }
    // Порядок KNN — в плоских градусах: кандидатов с запасом, точный порядок — по geography
    const candidates = Math.max(16, k * 4)
    const c = this.ident('c')
    const n = this.ident('n')
    const lateral = [
      `SELECT ${c}.*${rank}`,
      'FROM (',
      `  SELECT ${inner.join(', ')}`,
      `  FROM ${this.ref(other)}`,
      `  WHERE ${where.join(' AND ')}`,
      `  ORDER BY ${tg} <-> ${g}`,
      `  LIMIT ${candidates}`,
      `) AS ${c}`,
      `ORDER BY ${c}.${this.ident(distanceInternal)}`,
      `LIMIT ${k}`,
    ].join('\n')
    const select = added.map((column) => `${n}.${this.ident(column.internal)}`)
    this.derive(
      `SELECT ${this.ref()}.*, ${select.join(', ')}\nFROM ${this.ref()}\nLEFT JOIN LATERAL (\n  ${lateral.replaceAll('\n', '\n  ')}\n) AS ${n} ON TRUE`,
      [...relation.columns, ...added],
      {
        restricted: mergeSets(relation.restricted, other.restricted),
        unavailable: mergeSets(relation.unavailable, other.unavailable),
        qualifiers: new Set([...relation.qualifiers, ...other.qualifiers]),
      },
    )
  }

  /**
   * Территория уровня `level`, в которой лежит геометрия строки (точка на
   * поверхности — для линий и полигонов); на общей границе — первая по коду.
   * Поле по умолчанию — `<уровень>_id` (`district_id`).
   */
  private assignTerritory(): void {
    const geom = this.geometry()
    const level = this.params.choice('level', TERRITORY_LEVELS)
    if (level === undefined) {
      fail(this.params.at('level'), `Уровень территории — один из: ${TERRITORY_LEVELS.join(', ')}`)
    }
    const name = this.outputName(`${level}_id`)
    const path = this.params.at('level')
    const directory = this.territories(path)
    const column = (field: string) => this.col(directoryColumn(directory, field, path), directory)
    const lookup = [
      `SELECT ${column('id')}`,
      `FROM ${this.ref(directory)}`,
      `WHERE ${column('level')} = ${this.state.binder.add(level, 'text')}`,
      `  AND ST_Intersects(${column('geom')}, ST_PointOnSurface(${this.col(geom)}))`,
      `ORDER BY ${column('code')}`,
      'LIMIT 1',
    ].join('\n')
    const internal = uniqueInternal(this.taken(), name)
    this.addColumns(
      [`(\n  ${lookup.replaceAll('\n', '\n  ')}\n) AS ${this.ident(internal)}`],
      [
        this.column(name, internal, 'uuid', {
          fieldType: 'territory',
          semantic: 'territory',
          label: LEVEL_LABELS[level],
        }),
      ],
    )
  }

  /** Меры по объектам цели, связанным со строкой (точки в полигоне, сумма поля…). */
  private spatialJoin(): void {
    const geom = this.geometry()
    const predicate = this.params.choice('predicate', PREDICATES) ?? 'intersects'
    if (predicate !== 'dwithin' && this.params.has('distance')) {
      fail(this.params.at('distance'), 'Расстояние задаётся только для предиката dwithin')
    }
    const distance =
      predicate === 'dwithin' ? this.meters(this.params.number('distance', DISTANCE, true)) : null
    const target = this.target(false)
    if (target.kind !== 'relation') return
    const other = target.relation
    const reserved = new Set(
      this.rel.columns.filter((column) => !column.hidden).map((column) => column.name),
    )
    const measures = this.measures(other, this.taken(), reserved)
    const s = this.ident('s')
    const test = this.relate(predicate, this.col(geom), this.col(target.geom, other), distance)
    const lateral = [
      `SELECT ${measures.map((m) => `${m.sql} AS ${this.ident(m.column.internal)}`).join(', ')}`,
      `FROM ${this.ref(other)}`,
      `WHERE ${test}`,
    ].join('\n')
    const select = measures.map((m) => `${s}.${this.ident(m.column.internal)}`)
    this.derive(
      `SELECT ${this.ref()}.*, ${select.join(', ')}\nFROM ${this.ref()}\nLEFT JOIN LATERAL (\n  ${lateral.replaceAll('\n', '\n  ')}\n) AS ${s} ON TRUE`,
      [...this.rel.columns, ...measures.map((m) => m.column)],
    )
  }

  /**
   * Квадратная или шестиугольная сетка с мерами по ячейкам. Сетка строится в
   * зоне UTM центра охвата данных (метры без искажения); в результате — только
   * ячейки с объектами: идентификатор `i:j`, граница в WGS 84 и меры.
   */
  private grid(op: 'grid' | 'hexgrid'): void {
    const geom = this.geometry()
    const size = this.meters(this.params.number('size', CELL_SIZE, true))
    const relation = this.rel
    const g = this.col(geom)
    const cellName = 'cell'
    const geomName = geom.name === cellName ? `${geom.name}_geom` : geom.name
    const measures = this.measures(
      relation,
      new Set(['i', 'j', cellName, geomName]),
      new Set([cellName, geomName]),
    )
    const [gridFn, cellFn] =
      op === 'hexgrid' ? ['ST_HexagonGrid', 'ST_Hexagon'] : ['ST_SquareGrid', 'ST_Square']
    const zone = this.host.nextName()
    const center = this.ident('c')
    this.state.addCte(
      zone,
      [
        `SELECT (CASE WHEN ST_Y(${center}) < 0 THEN 32700 ELSE 32600 END`,
        `  + LEAST(60, GREATEST(1, floor((ST_X(${center}) + 180) / 6)::int + 1)))::int AS ${this.ident('srid')}`,
        `FROM (SELECT ST_Centroid(ST_Extent(${g})::geometry) AS ${center} FROM ${this.ref()}) AS ${this.ident('e')}`,
      ].join('\n'),
    )
    const z = this.ident('z')
    const h = this.ident('h')
    const srid = `${z}.${this.ident('srid')}`
    const projected = `ST_Transform(${g}, ${srid})`
    const cells = this.host.nextName()
    this.state.addCte(
      cells,
      [
        `SELECT ${h}.${this.ident('i')} AS ${this.ident('i')}, ${h}.${this.ident('j')} AS ${this.ident('j')}, ${measures
          .map((m) => `${m.sql} AS ${this.ident(m.column.internal)}`)
          .join(', ')}`,
        `FROM ${this.ref()}`,
        `CROSS JOIN ${this.ident(zone)} AS ${z}`,
        `CROSS JOIN LATERAL ${gridFn}(${size}, ${projected}) AS ${h}`,
        `WHERE ${g} IS NOT NULL AND NOT ST_IsEmpty(${g}) AND ST_Intersects(${h}.${this.ident('geom')}, ${projected})`,
        `GROUP BY 1, 2`,
      ].join('\n'),
    )
    const r = this.ident(cells)
    const i = `${r}.${this.ident('i')}`
    const j = `${r}.${this.ident('j')}`
    const geomColumn: Column = {
      name: geomName,
      qualifier: null,
      internal: geomName,
      type: 'geometry',
      meta: { ...geom.meta, format: null },
      hidden: false,
    }
    const select = [
      `concat(${i}, ':', ${j}) AS ${this.ident(cellName)}`,
      `ST_Transform(ST_SetSRID(${cellFn}(${size}, ${i}, ${j}), ${srid}), 4326) AS ${this.ident(geomName)}`,
      ...measures.map((m) => `${r}.${this.ident(m.column.internal)}`),
    ]
    this.restructure(
      `SELECT ${select.join(', ')}\nFROM ${r}\nCROSS JOIN ${this.ident(zone)} AS ${z}`,
      [
        this.column(cellName, cellName, 'text', {
          fieldType: 'identifier',
          semantic: 'identifier',
          label: LABELS.cell,
        }),
        geomColumn,
        ...measures.map((m) => m.column),
      ],
    )
  }

  /** Растворение: объединение геометрий по значениям полей `by` с мерами по группе. */
  private dissolve(): void {
    const geom = this.geometry()
    const relation = this.rel
    const by = this.params.stringList('by') ?? []
    const taken = new Set<string>()
    const names = new Set<string>()
    const select: string[] = []
    const columns: Column[] = []
    by.forEach((ref, index) => {
      const at = [...this.params.at('by'), index]
      const column = resolveColumn(relation, ref, at)
      if (column.type === 'geometry')
        fail(at, 'Растворять по геометрии нельзя — укажите поле-признак')
      if (names.has(column.name)) fail(at, `Поле «${column.name}» в группировке повторяется`)
      names.add(column.name)
      const internal = uniqueInternal(taken, column.name)
      taken.add(internal)
      select.push(`${this.col(column)} AS ${this.ident(internal)}`)
      columns.push({ ...column, qualifier: null, internal, hidden: false, system: false })
    })
    const geomInternal = uniqueInternal(taken, geom.name)
    taken.add(geomInternal)
    names.add(geom.name)
    select.push(`ST_Multi(ST_Union(${this.col(geom)})) AS ${this.ident(geomInternal)}`)
    columns.push({
      name: geom.name,
      qualifier: null,
      internal: geomInternal,
      type: 'geometry',
      meta: { ...geom.meta, format: null },
      hidden: false,
    })
    const measures = this.measures(relation, taken, names)
    for (const measure of measures) {
      select.push(`${measure.sql} AS ${this.ident(measure.column.internal)}`)
      columns.push(measure.column)
    }
    const group = by.length ? `\nGROUP BY ${by.map((_, index) => index + 1).join(', ')}` : ''
    this.restructure(
      `SELECT ${select.join(', ')}\nFROM ${this.ref()}\nWHERE ${this.col(geom)} IS NOT NULL${group}`,
      columns,
    )
  }

  /** Вырезание по цели: остаётся часть геометрии внутри цели той же размерности. */
  private clip(): void {
    const geom = this.geometry()
    const target = this.target(true)
    const mask = this.host.nextName()
    const clip = this.ident('clip')
    if (target.kind === 'literal') {
      this.state.addCte(mask, `SELECT ${target.sql} AS ${clip}`)
    } else {
      const tg = this.col(target.geom, target.relation)
      this.state.addCte(
        mask,
        `SELECT ST_Union(${tg}) AS ${clip}\nFROM ${this.ref(target.relation)}\nWHERE ${tg} IS NOT NULL`,
      )
    }
    const m = this.ident('m')
    const g = this.col(geom)
    const shape = `${m}.${clip}`
    const select = this.rel.columns.map((column) =>
      column.internal === geom.internal
        ? `ST_CollectionExtract(ST_Intersection(${g}, ${shape}), ST_Dimension(${g}) + 1) AS ${this.ident(column.internal)}`
        : this.col(column),
    )
    this.derive(
      `SELECT ${select.join(', ')}\nFROM ${this.ref()}\nCROSS JOIN ${this.ident(mask)} AS ${m}\nWHERE ST_Intersects(${g}, ${shape})`,
      this.rel.columns,
    )
    // Касание границей даёт пустую часть той же размерности — такие строки не нужны
    const clipped = this.col(geom)
    this.derive(`SELECT *\nFROM ${this.ref()}\nWHERE NOT ST_IsEmpty(${clipped})`, this.rel.columns)
  }

  // ─── Меры ──────────────────────────────────────────────────────────────────

  /**
   * Меры `params.measures` над отношением `source` (по умолчанию — число
   * объектов). `taken` — занятые внутренние имена, `reserved` — имена полей результата.
   */
  private measures(source: Relation, taken: Set<string>, reserved: ReadonlySet<string>): Measure[] {
    const path = this.params.at('measures')
    const raw = this.params.has('measures')
      ? this.params.value('measures')
      : [{ alias: 'count', agg: 'count' }]
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MEASURES) {
      return fail(path, `Меры — непустой список (до ${MAX_MEASURES})`)
    }
    const names = new Set<string>()
    return raw.map((item, index): Measure => {
      const at = [...path, index]
      if (!isRecord(item)) return fail(at, 'Мера — объект {alias, agg, field?}')
      allowedKeys(item, ['alias', 'agg', 'field'], at)
      const { alias, agg, field } = item
      if (typeof alias !== 'string' || !ALIAS.test(alias) || alias.length > 64) {
        return fail([...at, 'alias'], 'Имя меры: латиница, цифры, подчёркивание (до 64 символов)')
      }
      if (names.has(alias) || reserved.has(alias)) {
        fail([...at, 'alias'], `Поле «${alias}» уже есть`, { hint: 'Задайте другой alias' })
      }
      names.add(alias)
      if (!(MEASURE_AGGS as readonly unknown[]).includes(agg)) {
        return fail([...at, 'agg'], `Мера — одна из: ${MEASURE_AGGS.join(', ')}`)
      }
      if (field !== undefined && typeof field !== 'string') {
        return fail([...at, 'field'], 'Поле меры — строкой')
      }
      const column = field === undefined ? null : resolveColumn(source, field, [...at, 'field'])
      const compiled = measureSql(agg as MeasureAgg, column, source, this.d, [...at, 'field'])
      const internal = uniqueInternal(taken, alias)
      taken.add(internal)
      const label = alias === 'count' && agg === 'count' && column === null ? LABELS.count : null
      return {
        sql: compiled.sql,
        column: {
          name: alias,
          qualifier: null,
          internal,
          type: compiled.type,
          meta: { ...compiled.meta, label },
          hidden: false,
        },
      }
    })
  }
}

/** SQL агрегата меры и тип результата — как у мер шага aggregate. */
function measureSql(
  agg: MeasureAgg,
  column: Column | null,
  source: Relation,
  dialect: CompileState['dialect'],
  path: IssuePath,
): { sql: string; type: ValueType; meta: ColumnMeta } {
  const sql = column ? columnSql(dialect, source, column) : null
  const measure = (fieldType: FieldType, format: ColumnMeta['format'] = null): ColumnMeta => ({
    fieldType,
    semantic: 'measure',
    label: null,
    format,
  })
  const need = (): { column: Column; sql: string } => {
    if (!column || !sql) return fail(path, `Для меры «${agg}» нужно поле`)
    return { column, sql }
  }
  switch (agg) {
    case 'count':
      return { sql: sql ? `count(${sql})` : 'count(*)', type: 'number', meta: measure('integer') }
    case 'count_distinct':
      return { sql: `count(DISTINCT ${need().sql})`, type: 'number', meta: measure('integer') }
    case 'sum':
    case 'avg': {
      const value = need()
      if (value.column.type !== 'number') {
        fail(
          path,
          `Мера «${agg}» считается по числам, а получено: ${VALUE_TYPE_LABELS[value.column.type]}`,
        )
      }
      // Сумма сохраняет тип поля (деньги, целое), среднее целых — дробное число
      const source = value.column.meta.fieldType
      const fieldType = agg === 'sum' || NUMERIC_FIELD_TYPES.has(source) ? source : 'number'
      return {
        sql: `${agg}(${value.sql})`,
        type: 'number',
        meta: measure(fieldType, value.column.meta.format),
      }
    }
    case 'min':
    case 'max': {
      const value = need()
      if (!isOrderable(value.column.type)) {
        fail(
          path,
          `Мера «${agg}» не считается по значениям «${VALUE_TYPE_LABELS[value.column.type]}»`,
        )
      }
      const meta = { ...value.column.meta, label: null }
      return {
        sql: `${agg}(${value.sql})`,
        type: value.column.type,
        meta: value.column.type === 'number' ? { ...meta, semantic: 'measure' } : meta,
      }
    }
  }
}

/** Поле геометрии отношения: заданное или единственное. */
function geometryColumn(
  relation: Relation,
  ref: string | undefined,
  path: IssuePath,
  whose: string,
): Column {
  if (ref !== undefined) {
    const column = resolveColumn(relation, ref, path)
    if (column.type !== 'geometry') {
      fail(path, `Поле «${ref}» — не геометрия, а ${VALUE_TYPE_LABELS[column.type]}`)
    }
    return column
  }
  const candidates = relation.columns.filter(
    (column) => !column.hidden && column.type === 'geometry',
  )
  const [only] = candidates
  if (only && candidates.length === 1) return only
  if (!only) {
    return fail(path, `В ${whose} нет поля геометрии`, {
      hint: 'Пространственные операции работают с полем типа «геометрия»',
    })
  }
  const names = candidates.map((column) =>
    column.qualifier ? `${column.qualifier}.${column.name}` : column.name,
  )
  return fail(path, `В ${whose} несколько полей геометрии: ${names.join(', ')}`, {
    hint: 'Укажите поле геометрии в field',
  })
}

/** Поле справочника территорий, на которое опирается шаг. */
function directoryColumn(relation: Relation, name: string, path: IssuePath): Column {
  const found = findColumn(relation, null, name)
  if ('message' in found) return fail(path, `В справочнике территорий нет поля «${name}»`)
  return found
}

function allowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: IssuePath,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail([...path, key], `Неизвестное поле «${key}»`, { hint: `Допустимо: ${keys.join(', ')}` })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSystemName(value: unknown): value is (typeof SYSTEM_DATASETS)[number] {
  return typeof value === 'string' && (SYSTEM_DATASETS as readonly string[]).includes(value)
}

function mergeSets(
  a: ReadonlyMap<string, Set<string>>,
  b: ReadonlyMap<string, Set<string>>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const source of [a, b]) {
    for (const [key, names] of source) {
      result.set(key, new Set([...(result.get(key) ?? []), ...names]))
    }
  }
  return result
}

/** Параметры операции: известные ключи, числа (значением или `@param:имя`), строки, списки. */
class ParamReader {
  constructor(
    private readonly state: CompileState,
    private readonly values: Record<string, unknown>,
    readonly path: IssuePath,
    allowed: readonly string[],
  ) {
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) {
        fail([...path, key], `Неизвестный параметр «${key}»`, {
          hint: `Параметры операции: ${allowed.join(', ')}`,
        })
      }
    }
  }

  at(key: string): IssuePath {
    return [...this.path, key]
  }

  has(key: string): boolean {
    return this.values[key] !== undefined && this.values[key] !== null
  }

  value(key: string): unknown {
    return this.values[key]
  }

  /** Число из диапазона; `@param:имя` — значение параметра запроса. */
  number(
    key: string,
    range: { min: number; max: number; positive?: boolean },
    required: true,
  ): number
  number(key: string, range: { min: number; max: number; positive?: boolean }): number | undefined
  number(
    key: string,
    range: { min: number; max: number; positive?: boolean },
    required = false,
  ): number | undefined {
    let value = this.values[key]
    if (value === undefined || value === null) {
      if (required) fail(this.at(key), `Нужен параметр «${key}»`)
      return undefined
    }
    if (typeof value === 'string' && value.startsWith('@param:')) {
      value = this.param(value.slice('@param:'.length), this.at(key))
    }
    if (typeof value === 'string' && NUMERIC.test(value.trim())) value = Number(value)
    const low = range.positive ? `больше ${range.min}` : `не меньше ${range.min}`
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < range.min ||
      (range.positive && value === range.min) ||
      value > range.max
    ) {
      return fail(this.at(key), `«${key}» — число ${low} и не больше ${range.max}`)
    }
    return value
  }

  integer(key: string, min: number, max: number): number | undefined {
    const value = this.number(key, { min, max })
    if (value !== undefined && !Number.isInteger(value)) {
      fail(this.at(key), `«${key}» — целое число от ${min} до ${max}`)
    }
    return value
  }

  string(key: string): string | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string' || !value || value.length > 160) {
      return fail(this.at(key), `«${key}» — непустая строка`)
    }
    return value
  }

  boolean(key: string): boolean | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'boolean') return fail(this.at(key), `«${key}» — true или false`)
    return value
  }

  choice<T extends string>(key: string, options: readonly T[]): T | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (!(options as readonly unknown[]).includes(value)) {
      return fail(this.at(key), `«${key}» — одно из: ${options.join(', ')}`)
    }
    return value as T
  }

  stringList(key: string): string[] | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160)
    ) {
      return fail(this.at(key), `«${key}» — список полей`)
    }
    return value as string[]
  }

  private param(name: string, path: IssuePath): unknown {
    const value = this.state.paramValue(name, path)
    if (value === MISSING) fail(path, `Не задан параметр «${name}»`)
    return value
  }
}
