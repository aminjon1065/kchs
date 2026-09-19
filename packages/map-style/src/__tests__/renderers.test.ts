import { formatNumber, formatPercent } from '@kchs/fields'
import { describe, expect, it } from 'vitest'
import { compileLayerStyle } from '../compile.js'
import { paletteColors } from '../palette.js'
import {
  context,
  evaluate,
  layer,
  passes,
  style,
  THEME_DARK,
  THEME_LIGHT,
  validate,
} from './fixtures.js'

const ru = (value: number) => formatNumber(value, {}, { locale: 'ru' })
/** Неразрывный пробел: Intl отбивает им сокращения («1,2 тыс.») и знак процента. */
const NBSP = String.fromCharCode(0xa0)

describe('рендереры: значения выражений на объектах', () => {
  it('категории: match по строке, «прочее», пустое значение, подписи из вариантов поля', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: {
          kind: 'categorized',
          field: 'kind',
          categories: [
            { value: 'school', color: 'categorical.1' },
            { value: 'hospital', color: 'danger', label: { ru: 'Больницы' } },
          ],
          other: { color: 'other' },
        },
      }),
      context(),
    )
    const point = layer(compiled.layers, 'point')
    expect(evaluate(point, 'circle-color', { kind: 'school' })).toBe('#2F62E6')
    expect(evaluate(point, 'circle-color', { kind: 'hospital' })).toBe('#CE2B2B')
    expect(evaluate(point, 'circle-color', { kind: 'market' })).toBe('#5B7083')
    expect(evaluate(point, 'circle-color', {})).toBe('#5B7083')
    expect(passes(point, { kind: 'market' })).toBe(true)
    expect(compiled.legend.title).toBe('Вид')
    expect(compiled.legend.sections[0]?.items.map((item) => item.label)).toEqual([
      'Школа',
      'Больницы',
      'Прочее',
    ])
  })

  it('категории без «прочего»: объекты вне списка не рисуются; пустое значение — своя категория', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'polygon',
        renderer: {
          kind: 'categorized',
          field: 'kind',
          categories: [
            { value: 'school', color: 'teal.5' },
            { value: null, color: 'neutral' },
          ],
          other: null,
        },
      }),
      context(),
    )
    const fill = layer(compiled.layers, 'fill')
    expect(passes(fill, { kind: 'school' })).toBe(true)
    expect(passes(fill, {})).toBe(true)
    expect(passes(fill, { kind: 'police' })).toBe(false)
    expect(evaluate(fill, 'fill-color', {})).toBe('#666875')
    expect(evaluate(fill, 'fill-color', { kind: 'school' })).toBe(THEME_LIGHT.sequential.teal[4])
    expect(compiled.legend.sections[0]?.items.map((item) => item.label)).toEqual([
      'Школа',
      'Нет значения',
    ])
  })

  it('категории чисел: пустое не равно нулю; дробные сравниваются по одному; «да/нет»', () => {
    const integers = layer(
      compileLayerStyle(
        style({
          geometry: 'point',
          renderer: {
            kind: 'categorized',
            field: 'severity',
            categories: [
              { value: 0, color: 'success' },
              { value: '5', color: 'danger' },
            ],
            other: { color: 'other' },
          },
        }),
        context(),
      ).layers,
      'point',
    )
    expect(evaluate(integers, 'circle-color', { severity: 0 })).toBe('#177E50')
    expect(evaluate(integers, 'circle-color', { severity: 5 })).toBe('#CE2B2B')
    expect(evaluate(integers, 'circle-color', { severity: '5' })).toBe('#CE2B2B')
    expect(evaluate(integers, 'circle-color', {})).toBe('#5B7083')

    const fractions = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: {
          kind: 'categorized',
          field: 'ratio',
          categories: [
            { value: 0.5, color: 'categorical.2' },
            { value: 1.5, color: 'categorical.3' },
          ],
          other: null,
        },
      }),
      context(),
    )
    expect(validate(fractions.layers)).toEqual([])
    const point = layer(fractions.layers, 'point')
    expect(evaluate(point, 'circle-color', { ratio: 1.5 })).toBe('#D9509C')
    expect(passes(point, { ratio: 1.5 })).toBe(true)
    expect(passes(point, { ratio: 1 })).toBe(false)
    expect(passes(point, {})).toBe(false)

    const booleans = layer(
      compileLayerStyle(
        style({
          geometry: 'line',
          renderer: {
            kind: 'categorized',
            field: 'active',
            categories: [
              { value: true, color: 'success' },
              { value: false, color: 'danger' },
            ],
            other: { color: 'other' },
          },
        }),
        context(),
      ).layers,
      'line',
    )
    expect(evaluate(booleans, 'line-color', { active: true })).toBe('#177E50')
    expect(evaluate(booleans, 'line-color', { active: false })).toBe('#CE2B2B')
    expect(evaluate(booleans, 'line-color', {})).toBe('#5B7083')
  })

  it('повтор категории — замечание, в выражении одна ветка', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: {
          kind: 'categorized',
          field: 'kind',
          categories: [
            { value: 'school', color: 'categorical.1' },
            { value: 'school', color: 'categorical.2' },
          ],
        },
      }),
      context(),
    )
    expect(validate(compiled.layers)).toEqual([])
    expect(compiled.warnings).toEqual([
      { code: 'category-duplicate', path: 'renderer.categories.1.value', detail: '"school"' },
    ])
    expect(evaluate(layer(compiled.layers, 'point'), 'circle-color', { kind: 'school' })).toBe(
      '#2F62E6',
    )
  })

  it('классы: step по границам, пустое и деление на ноль — «нет данных»', () => {
    const breaks = [0, 10, 100, 1000]
    const compiled = compileLayerStyle(
      style({
        geometry: 'polygon',
        renderer: {
          kind: 'graduated',
          field: 'population',
          method: 'equal',
          classes: 3,
          palette: { name: 'orange', reverse: false },
          normalizeBy: 'area_km2',
        },
      }),
      context({ breaks }),
    )
    const colors = paletteColors(THEME_LIGHT, 'orange', 3)
    const fill = layer(compiled.layers, 'fill')
    expect(evaluate(fill, 'fill-color', { population: 50, area_km2: 10 })).toBe(colors[0])
    expect(evaluate(fill, 'fill-color', { population: 500, area_km2: 10 })).toBe(colors[1])
    expect(evaluate(fill, 'fill-color', { population: 1000, area_km2: 1 })).toBe(colors[2])
    expect(evaluate(fill, 'fill-color', { population: 5000, area_km2: 1 })).toBe(colors[2])
    expect(evaluate(fill, 'fill-color', { population: 50, area_km2: 0 })).toBe('#5B7083')
    expect(evaluate(fill, 'fill-color', { area_km2: 3 })).toBe('#5B7083')
    expect(compiled.legend.title).toBe('Население / Площадь, км²')
    expect(compiled.legend.sections[0]?.items.map((item) => item.label)).toEqual([
      '0 – 10',
      '10 – 100',
      `100 – ${ru(1000)}`,
    ])
  })

  it('классы: без границ — один цвет палитры и пояснение в легенде', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: { kind: 'graduated', field: 'population', method: 'quantile' },
      }),
      context(),
    )
    expect(validate(compiled.layers)).toEqual([])
    expect(compiled.warnings).toEqual([{ code: 'breaks-missing', path: 'renderer' }])
    expect(compiled.legend.sections).toEqual([])
    expect(compiled.legend.note).toBe('Классы появятся, когда будут рассчитаны границы')
  })

  it('классы: ручные границы важнее вычисленных; 9 классов — вся шкала с нейтралью посередине', () => {
    const breaks = [-4, -3, -2, -1, -0.5, 0.5, 1, 2, 3, 4]
    const compiled = compileLayerStyle(
      style({
        geometry: 'polygon',
        renderer: {
          kind: 'graduated',
          field: 'ratio',
          method: 'manual',
          classes: 9,
          breaks,
          palette: { name: 'red-blue', reverse: false },
        },
      }),
      context({ breaks: [0, 1] }),
    )
    const fill = layer(compiled.layers, 'fill')
    expect(evaluate(fill, 'fill-color', { ratio: 0 })).toBe('#F1F1F3')
    expect(evaluate(fill, 'fill-color', { ratio: -10 })).toBe('#D63B3B')
    expect(evaluate(fill, 'fill-color', { ratio: 10 })).toBe('#2F62E6')
    expect(compiled.legend.sections[0]?.items).toHaveLength(9)
  })

  it('классы размером: у точек — диаметр по классу, у полигонов — только цвет с замечанием', () => {
    const points = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: {
          kind: 'graduated',
          field: 'capacity',
          method: 'equal',
          classes: 4,
          visual: { target: 'size' },
        },
      }),
      context({ breaks: [0, 100, 200, 300, 400] }),
    )
    const point = layer(points.layers, 'point')
    expect(evaluate(point, 'circle-radius', { capacity: 50 })).toBe(3)
    expect(evaluate(point, 'circle-radius', { capacity: 399 })).toBe(12)
    // Цвет один — из палитры
    expect(evaluate(point, 'circle-color', { capacity: 50 })).toBe(
      evaluate(point, 'circle-color', { capacity: 399 }),
    )
    const polygons = compileLayerStyle(
      style({
        geometry: 'polygon',
        renderer: { kind: 'graduated', field: 'capacity', visual: { target: 'size' } },
      }),
      context({ breaks: [0, 100, 200] }),
    )
    expect(polygons.warnings.map((w) => w.code)).toEqual(['renderer-geometry'])
  })

  it('размер по значению: корень площади между min и max диапазона, пустые не рисуются', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: { kind: 'proportional', field: 'capacity', min: 4, max: 40, scale: 'sqrt' },
      }),
      context({ domains: { capacity: { min: 0, max: 400 } } }),
    )
    const point = layer(compiled.layers, 'point')
    expect(evaluate(point, 'circle-radius', { capacity: 0 })).toBe(2)
    expect(evaluate(point, 'circle-radius', { capacity: 100 })).toBe(11)
    expect(evaluate(point, 'circle-radius', { capacity: 400 })).toBe(20)
    expect(evaluate(point, 'circle-radius', { capacity: 10_000 })).toBe(20)
    expect(passes(point, {})).toBe(false)
    const items = compiled.legend.sections[0]?.items ?? []
    expect(items.map((item) => item.label)).toEqual(['400', '100', '0'])
    expect(
      items.map((item) => (item.swatch.kind === 'proportional-circle' ? item.swatch.size : 0)),
    ).toEqual([40, 22, 4])
  })

  it('размер по значению: логарифм и линейная шкала; без диапазона — средний размер и замечание', () => {
    const log = layer(
      compileLayerStyle(
        style({
          geometry: 'point',
          renderer: { kind: 'proportional', field: 'population', min: 10, max: 30, scale: 'log' },
        }),
        context({ domains: { population: { min: 100, max: 10_000 } } }),
      ).layers,
      'point',
    )
    expect(evaluate(log, 'circle-radius', { population: 1000 })).toBeCloseTo(10, 4)
    const linear = layer(
      compileLayerStyle(
        style({
          geometry: 'line',
          renderer: { kind: 'proportional', field: 'capacity', min: 2, max: 10, scale: 'linear' },
        }),
        context({ domains: { capacity: { min: 0, max: 100 } } }),
      ).layers,
      'line',
    )
    expect(evaluate(linear, 'line-width', { capacity: 50 })).toBe(6)
    const missing = compileLayerStyle(
      style({ geometry: 'point', renderer: { kind: 'proportional', field: 'capacity' } }),
      context(),
    )
    expect(missing.warnings).toEqual([
      { code: 'domain-missing', path: 'renderer.field', detail: 'capacity' },
    ])
    expect(evaluate(layer(missing.layers, 'point'), 'circle-radius', { capacity: 5 })).toBe(7)
  })

  it('правила: первое подходящее правило, «прочее», неизвестное на клиенте условие не красит', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: {
          kind: 'rule',
          rules: [
            { filter: { field: 'severity', op: 'gte', value: 4 }, color: 'danger' },
            { filter: { field: 'kind', op: 'eq', value: 'school' }, color: 'success' },
            { filter: { field: 'name', op: 'regex', value: '^Школа' }, color: 'purple' },
          ],
          other: null,
        },
      }),
      context(),
    )
    const point = layer(compiled.layers, 'point')
    expect(evaluate(point, 'circle-color', { severity: 5, kind: 'school' })).toBe('#CE2B2B')
    expect(evaluate(point, 'circle-color', { severity: 1, kind: 'school' })).toBe('#177E50')
    expect(passes(point, { severity: 1, kind: 'police', name: 'Школа №1' })).toBe(false)
    expect(passes(point, { severity: 4 })).toBe(true)
    expect(compiled.warnings).toEqual([
      {
        code: 'filter-unsupported',
        path: 'renderer.rules.2.filter',
        detail: 'regex: оператор не вычисляется на карте',
      },
    ])
    expect(compiled.legend.sections[0]?.items.map((item) => item.label)).toEqual([
      'Правило 1',
      'Правило 2',
      'Правило 3',
    ])
  })

  it('тепловая карта: вес по диапазону поля, кластеры сервера весят по числу точек', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: { kind: 'heatmap', weightField: 'severity', palette: { name: 'viridis' } },
        cluster: { enabled: true },
      }),
      context({ domains: { severity: { min: 1, max: 5 } }, theme: THEME_DARK }),
    )
    expect(compiled.layers.map((l) => l.id)).toEqual(['objects:heatmap'])
    const heatmap = layer(compiled.layers, 'heatmap')
    expect(evaluate(heatmap, 'heatmap-weight', { severity: 3 })).toBe(0.5)
    expect(evaluate(heatmap, 'heatmap-weight', { severity: 5, point_count: 10 })).toBe(10)
    expect(evaluate(heatmap, 'heatmap-weight', {})).toBe(0)
    const swatch = compiled.legend.sections[0]?.items[0]?.swatch
    expect(swatch?.kind).toBe('heatmap-gradient')
    // Тёмная тема: от тёмного к яркому
    expect(swatch?.kind === 'heatmap-gradient' && swatch.stops.map((s) => s.color)).toEqual(
      THEME_DARK.sequential.viridis,
    )
    expect(compiled.legend.title).toBe('Плотность')
  })
})

describe('точки, кластеры, подписи, время', () => {
  it('кластеры сервера: отдельные слои; обычные точки — без кластеров; число сокращается', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: { kind: 'simple', color: 'categorical.1' },
        cluster: { enabled: true, style: { min: 20, max: 60 } },
        label: { field: 'name' },
      }),
      context({ domains: { point_count: { min: 2, max: 1000 } } }),
    )
    expect(compiled.layers.map((l) => l.id)).toEqual([
      'objects:point',
      'objects:cluster',
      'objects:cluster-count',
      'objects:label',
    ])
    const point = layer(compiled.layers, 'point')
    const cluster = layer(compiled.layers, 'cluster')
    const count = layer(compiled.layers, 'cluster-count')
    expect(passes(point, { name: 'A' })).toBe(true)
    expect(passes(point, { point_count: 1 })).toBe(true)
    expect(passes(point, { point_count: 12 })).toBe(false)
    expect(passes(cluster, { point_count: 12 })).toBe(true)
    expect(passes(cluster, {})).toBe(false)
    expect(passes(layer(compiled.layers, 'label'), { point_count: 12 })).toBe(false)
    expect(evaluate(cluster, 'circle-radius', { point_count: 2 })).toBe(10)
    expect(evaluate(cluster, 'circle-radius', { point_count: 1000 })).toBeCloseTo(30, 6)
    expect(evaluate(cluster, 'circle-radius', { point_count: 50_000 })).toBeCloseTo(30, 6)
    expect(evaluate(count, 'text-field', { point_count: 7 })).toBe('7')
    expect(evaluate(count, 'text-field', { point_count: 1234 })).toBe(
      `${formatNumber(1.2, {}, { locale: 'ru' })}${NBSP}тыс.`,
    )
    expect(evaluate(count, 'text-field', { point_count: 15_300 })).toBe(`15${NBSP}тыс.`)
    expect(evaluate(count, 'text-field', { point_count: 2_500_000 })).toBe(
      `${formatNumber(2.5, {}, { locale: 'ru' })}${NBSP}млн`,
    )
  })

  it('кластеры в английском интерфейсе: K и M; в классах цвет кластера — «прочее»', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: {
          kind: 'categorized',
          field: 'kind',
          categories: [{ value: 'school', color: 'categorical.2' }],
        },
        cluster: { enabled: true },
      }),
      context({ locale: 'en' }),
    )
    const count = layer(compiled.layers, 'cluster-count')
    expect(evaluate(count, 'text-field', { point_count: 1234 })).toBe('1.2K')
    expect(evaluate(layer(compiled.layers, 'cluster'), 'circle-color', {})).toBe('#5B7083')
    expect(compiled.legend.sections.map((s) => s.id)).toEqual(['main', 'cluster'])
    expect(compiled.legend.sections[1]?.items[0]?.label).toBe('Group of features')
  })

  it('фигуры и значки — symbol с SDF-изображениями, размер значка по диаметру', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: { kind: 'simple', color: 'danger', icon: 'flame' },
        point: { size: 16 },
      }),
      context(),
    )
    const point = layer(compiled.layers, 'point')
    expect(point.type).toBe('symbol')
    expect(evaluate(point, 'icon-image', {})).toBe('kchs-icon-flame')
    expect(evaluate(point, 'icon-size', {})).toBe(0.5)
    expect(evaluate(point, 'icon-color', {})).toBe('#CE2B2B')
    expect(compiled.images).toEqual([
      { id: 'kchs-icon-flame', kind: 'icon', name: 'flame', sdf: true },
    ])
    const triangles = compileLayerStyle(
      style({ geometry: 'point', renderer: { kind: 'simple' }, point: { shape: 'triangle' } }),
      context(),
    )
    expect(triangles.images.map((image) => image.id)).toEqual(['kchs-shape-triangle'])
  })

  it('подписи: шаблон с форматом чисел, варианты выбора и «да/нет»; дата — замечание', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: { kind: 'simple' },
        label: { template: '{{kind}}: {{name}}, {{damage}} ({{active}}) {{share}}' },
      }),
      context(),
    )
    const label = layer(compiled.layers, 'label')
    const text = evaluate(label, 'text-field', {
      kind: 'hospital',
      name: 'ЦРБ Рудаки',
      damage: 1234.5,
      active: true,
      share: 0.125,
    })
    const money = formatNumber(1234.5, { precision: 2, currency: 'TJS' }, { locale: 'ru' })
    const share = formatPercent(0.125, { precision: 1 }, { locale: 'ru' })
    expect(text).toBe(`Больница: ЦРБ Рудаки, ${money} (Да) ${share}`)
    // Пустые значения — пустые части шаблона
    expect(evaluate(label, 'text-field', { name: 'Без вида' })).toBe(': Без вида,  () ')
    const dated = compileLayerStyle(
      style({ geometry: 'point', renderer: { kind: 'simple' }, label: { field: 'occurred_at' } }),
      context(),
    )
    expect(dated.warnings).toEqual([
      { code: 'label-format', path: 'label.field', detail: 'occurred_at' },
    ])
  })

  it('подписи линий — вдоль линии; «вдоль линии» у точек — замечание; приоритет по полю', () => {
    const line = compileLayerStyle(
      style({ geometry: 'line', renderer: { kind: 'simple' }, label: { field: 'name' } }),
      context(),
    )
    expect(evaluate(layer(line.layers, 'label'), 'symbol-placement', {})).toBe('line')
    const point = compileLayerStyle(
      style({
        geometry: 'point',
        renderer: { kind: 'simple' },
        label: { field: 'population', placement: 'line', priority: 'field' },
      }),
      context(),
    )
    expect(point.warnings.map((w) => w.code)).toEqual(['label-placement'])
    const label = layer(point.layers, 'label')
    expect(evaluate(label, 'symbol-sort-key', { population: 5000 })).toBe(-5000)
    expect(evaluate(label, 'text-field', { population: 5000 })).toBe(ru(5000))
  })

  it('время: момент — [from, to), интервал — включительно, накопление — до конца кадра', () => {
    const frame = { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 8, 2) }
    const at = (mode: 'instant' | 'range' | 'cumulative', t: number | undefined) =>
      passes(
        layer(
          compileLayerStyle(
            style({
              geometry: 'point',
              renderer: { kind: 'simple' },
              time: { field: 'occurred_at', mode },
            }),
            context({ time: frame }),
          ).layers,
          'point',
        ),
        t === undefined ? {} : { occurred_at: t },
      )
    expect(at('instant', frame.from)).toBe(true)
    expect(at('instant', frame.to)).toBe(false)
    expect(at('range', frame.to)).toBe(true)
    expect(at('range', frame.from - 1)).toBe(false)
    expect(at('cumulative', Date.UTC(2020, 0, 1))).toBe(true)
    expect(at('cumulative', frame.to + 1)).toBe(false)
    expect(at('range', undefined)).toBe(false)
    // Без кадра время фильтрует сервер: на клиенте фильтра нет
    const free = compileLayerStyle(
      style({ geometry: 'point', renderer: { kind: 'simple' }, time: { field: 'occurred_at' } }),
      context(),
    )
    expect('filter' in (free.layers[0] ?? {})).toBe(false)
  })

  it('фильтр слоя на клиенте — только по запросу; зумы стиля включительно', () => {
    const input = style({
      geometry: 'polygon',
      renderer: { kind: 'simple' },
      filter: { field: 'population', op: 'gt', value: 1000 },
      minZoom: 4,
      maxZoom: 12,
      label: { field: 'name', minZoom: 2 },
    })
    const server = compileLayerStyle(input, context())
    expect(server.layers.every((l) => !('filter' in l))).toBe(true)
    expect(server.layers.map((l) => [l.minzoom, l.maxzoom])).toEqual([
      [4, 13],
      [4, 13],
      [4, 13],
    ])
    const client = compileLayerStyle(input, context({ clientFilter: true }))
    expect(passes(layer(client.layers, 'fill'), { population: 1500 })).toBe(true)
    expect(passes(layer(client.layers, 'fill'), { population: 500 })).toBe(false)
  })

  it('источник GeoJSON — без source-layer; расхождение геометрии данных и стиля — замечание', () => {
    const compiled = compileLayerStyle(
      style({ geometry: 'point', renderer: { kind: 'simple' } }),
      context({ sourceLayer: null, source: 'objects-geojson', geometry: 'polygon' }),
    )
    expect(compiled.layers.map((l) => l.type)).toEqual(['fill', 'line'])
    expect(compiled.layers.every((l) => !('source-layer' in l))).toBe(true)
    expect(compiled.warnings.map((w) => w.code)).toEqual(['geometry-mismatch'])
  })

  it('легенда: свой заголовок и формат, скрытая легенда, неизвестный токен цвета', () => {
    const compiled = compileLayerStyle(
      style({
        geometry: 'polygon',
        renderer: {
          kind: 'graduated',
          field: 'ratio',
          method: 'equal',
          classes: 3,
        },
        legend: {
          title: { ru: 'Доля', en: 'Share' },
          format: { precision: 2, suffix: ' %' },
          show: false,
        },
      }),
      context({ breaks: [0, 1, 2, 3], locale: 'en' }),
    )
    expect(compiled.legend.show).toBe(false)
    expect(compiled.legend.title).toBe('Share')
    expect(compiled.legend.sections[0]?.items[0]?.label).toBe('0.00 % – 1.00 %')
    // Проценты — как проценты поля; верхний класс из одного значения — одно число
    const shares = compileLayerStyle(
      style({
        geometry: 'polygon',
        renderer: {
          kind: 'graduated',
          field: 'share',
          method: 'manual',
          breaks: [0, 0.125, 0.5, 0.5],
        },
      }),
      context(),
    )
    const percent = (value: number) => formatPercent(value, { precision: 1 }, { locale: 'ru' })
    expect(shares.legend.sections[0]?.items.map((item) => item.label)).toEqual([
      `${percent(0)} – ${percent(0.125)}`,
      `${percent(0.125)} – ${percent(0.5)}`,
      percent(0.5),
    ])
    const unknown = compileLayerStyle(
      style({ geometry: 'point', renderer: { kind: 'simple', color: 'magenta.3' } }),
      context(),
    )
    expect(unknown.warnings).toEqual([
      { code: 'color-unknown', path: 'renderer.color', detail: 'magenta.3' },
    ])
  })
})
