import { LayerStyle, type LayerStyleInput, type MapLayerEntry, MapSpec } from '@kchs/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { layers, objects } from '~/shared/db/schema/index.js'
import { LayerService } from './layer-service.js'
import { MapService } from './map-service.js'

/** Виды «Объектов защиты» демо-генератора (ADR-0054) → значок и цвет категории. */
const OBJECT_KINDS: ReadonlyArray<[string, string, string]> = [
  ['Школа', 'school', 'categorical.1'],
  ['Детский сад', 'baby', 'categorical.2'],
  ['Больница', 'hospital', 'danger'],
  ['Центр здоровья', 'stethoscope', 'categorical.4'],
  ['Пункт временного размещения', 'tent', 'categorical.3'],
  ['Рынок', 'store', 'categorical.5'],
  ['Стадион', 'users', 'categorical.6'],
  ['Мост', 'route', 'neutral'],
  ['Защитная дамба', 'dam', 'info'],
  ['Малая ГЭС', 'zap', 'categorical.7'],
  ['Подстанция', 'plug', 'categorical.8'],
  ['Водозабор', 'droplet', 'info'],
  ['Котельная', 'flame', 'warning'],
  ['АЗС', 'fuel', 'categorical.5'],
  ['Склад резерва', 'warehouse', 'neutral'],
  ['Пожарная часть', 'fire-extinguisher', 'danger'],
]

interface DemoLayer {
  /** Идентификатор набора демо-данных — `meta.demo` датасета. */
  demo: string
  name: string
  style: Omit<LayerStyleInput, 'version'>
  /** Видимость на демо-карте: 5 млн «Происшествий» включаются вручную. */
  visible: boolean
}

const DEMO_LAYERS: readonly DemoLayer[] = [
  {
    demo: 'risk_zones',
    name: 'Зоны риска',
    visible: true,
    style: {
      geometry: 'polygon',
      renderer: {
        kind: 'categorized',
        field: 'risk_level',
        categories: [
          { value: 'низкий', color: 'success' },
          { value: 'средний', color: 'warning' },
          { value: 'высокий', color: 'danger' },
          { value: 'очень высокий', color: 'purple' },
        ],
      },
      polygon: { fillOpacity: 0.35, outline: { width: 1, color: 'auto' } },
      label: { field: 'name', minZoom: 10 },
      popup: {
        title: '{{name}}',
        fields: ['hazard', 'risk_level', 'season', 'area_km2', 'assessed_on'],
        actions: ['open'],
      },
    },
  },
  {
    demo: 'hydro_posts',
    name: 'Гидропосты',
    visible: true,
    style: {
      geometry: 'point',
      renderer: { kind: 'simple', color: 'info', icon: 'waves' },
      point: { shape: 'icon', size: 18 },
      label: { field: 'name', minZoom: 9 },
      popup: { title: '{{name}}', fields: ['river', 'danger_level_cm'], actions: ['open'] },
    },
  },
  {
    demo: 'protected_objects',
    name: 'Объекты защиты',
    visible: true,
    style: {
      geometry: 'point',
      renderer: {
        kind: 'categorized',
        field: 'object_type',
        categories: OBJECT_KINDS.map(([value, icon, color]) => ({ value, icon, color })),
        other: { color: 'other' },
      },
      point: { shape: 'icon', size: 18 },
      // Ячейка шире самого крупного кружка кластера — кружки не налезают друг на друга
      cluster: { enabled: true, radius: 60 },
      label: { field: 'name', minZoom: 13 },
      popup: {
        title: '{{name}}',
        fields: ['object_type', 'capacity', 'condition', 'seismic_rating'],
        actions: ['open'],
      },
    },
  },
  {
    demo: 'incidents',
    name: 'Происшествия',
    visible: false,
    style: {
      geometry: 'point',
      renderer: { kind: 'simple', color: 'danger' },
      point: { size: 6 },
      cluster: { enabled: true },
      time: { field: 'occurred_at', mode: 'range', step: 'day' },
      popup: {
        title: '{{code}}',
        fields: ['occurred_at', 'type_code', 'damage', 'injured', 'deaths'],
        actions: ['open'],
      },
    },
  },
]

const DEMO_MAP = 'Оперативная обстановка'

export interface DemoLayersResult {
  layers: number
  created: number
  mapId: string | null
}

/**
 * Демо-слои и карта (P2-E06): слои над демо-датасетами пространства
 * (ADR-0063) — «Зоны риска», «Гидропосты», «Объекты защиты», «Происшествия» —
 * и карта «Оперативная обстановка». Повторный сид ничего не дублирует: слой
 * с тем же названием над тем же датасетом и карта с тем же названием берутся
 * как есть.
 */
export const DemoLayers = {
  async seed(ctx: Ctx, spaceId: string): Promise<DemoLayersResult> {
    const datasets = await db()
      .select({ id: objects.id, demo: sql<string>`${objects.meta}->>'demo'` })
      .from(objects)
      .where(
        and(
          eq(objects.type, 'dataset'),
          eq(objects.spaceId, spaceId),
          isNull(objects.deletedAt),
          sql`${objects.meta} ? 'demo'`,
        ),
      )
    const byDemo = new Map(datasets.map((item) => [item.demo, item.id]))
    const entries: MapLayerEntry[] = []
    let created = 0
    for (const demo of DEMO_LAYERS) {
      const datasetId = byDemo.get(demo.demo)
      if (!datasetId) continue
      const [existing] = await db()
        .select({ id: layers.id })
        .from(layers)
        .innerJoin(objects, eq(objects.id, layers.id))
        .where(
          and(
            eq(layers.datasetId, datasetId),
            eq(objects.title, demo.name),
            isNull(objects.deletedAt),
          ),
        )
        .limit(1)
      let layerId = existing?.id
      if (!layerId) {
        layerId = await db().transaction((tx) =>
          LayerService.create(tx, ctx, {
            name: demo.name,
            spaceId,
            datasetId,
            style: LayerStyle.parse({ version: 1, ...demo.style }),
            editable: false,
            moderated: false,
          }),
        )
        created++
      }
      entries.push({ layerId, visible: demo.visible, opacity: 1, group: null })
    }
    if (entries.length === 0) return { layers: 0, created, mapId: null }

    const [map] = await db()
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.type, 'map'),
          eq(objects.spaceId, spaceId),
          eq(objects.title, DEMO_MAP),
          isNull(objects.deletedAt),
        ),
      )
      .limit(1)
    const mapId =
      map?.id ??
      (await db().transaction((tx) =>
        MapService.create(tx, ctx, {
          name: DEMO_MAP,
          spaceId,
          parentId: null,
          spec: MapSpec.parse({
            layers: entries,
            camera: { center: [70.6, 38.75], zoom: 6, bearing: 0, pitch: 0 },
          }),
        }),
      ))
    return { layers: entries.length, created, mapId }
  },
}
