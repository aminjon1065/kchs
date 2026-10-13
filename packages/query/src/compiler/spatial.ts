import { type QuerySource, SPATIAL_OPS, TERRITORY_LEVELS } from '@kchs/contracts'
import { fail, type IssuePath } from '../errors.js'
import { VALUE_TYPE_LABELS } from '../value-types.js'
import { type Column, type Relation, resolveColumn, uniqueInternal } from './scope.js'
import {
  ALIAS,
  allowedKeys,
  CELL_SIZE,
  DISTANCE,
  directoryColumn,
  isRecord,
  isSystemName,
  LABELS,
  LEVEL_LABELS,
  MAX_MEASURES,
  MAX_NEAREST,
  MEASURE_AGGS,
  type Measure,
  type MeasureAgg,
  measureSql,
  mergeSets,
  PREDICATES,
  type SpatialHost,
  type SpatialStep,
  TARGET_OPS,
  TERRITORIES_DATASET,
} from './spatial/defs.js'
import { SpatialTargets } from './spatial/targets.js'

export type { SpatialHost } from './spatial/defs.js'
export { TERRITORIES_DATASET } from './spatial/defs.js'

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

class SpatialCompiler extends SpatialTargets {
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
