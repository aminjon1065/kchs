import { LayerStyle, type LayerStyleInput, type MapLayerEntry, MapSpec } from '@kchs/contracts'
import { LayerService } from '~/modules/gis/domain/layer-service.js'
import { MapService } from '~/modules/gis/domain/map-service.js'
import { db } from '~/shared/db/client.js'
import { findPackObject, markPackObject, type PackContext } from './context.js'

interface PackLayer {
  key: string
  dataset: string
  name: string
  visible: boolean
  /** Дежурный наносит объект прямо на карте обстановки (ADR-0076). */
  editable?: boolean
  style: Omit<LayerStyleInput, 'version'>
}

/** Виды «Объектов защиты» (как у демо-слоя, ADR-0054) → значок и цвет. */
const OBJECT_KINDS: ReadonlyArray<readonly [string, string, string]> = [
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
  ['Пожарная часть', 'siren', 'danger'],
]

/** Опасные явления → значок и цвет на карте обстановки. */
const HAZARD_ICONS: ReadonlyArray<readonly [string, string, string]> = [
  ['earthquake', 'crosshair', 'danger'],
  ['flood', 'waves', 'info'],
  ['mudflow', 'mountain', 'categorical.5'],
  ['landslide', 'mountain', 'categorical.6'],
  ['avalanche', 'snowflake', 'categorical.2'],
  ['fire', 'flame', 'warning'],
  ['drought', 'sun', 'categorical.8'],
  ['cyclone', 'tornado', 'purple'],
  ['volcano', 'mountain', 'categorical.3'],
  ['storm', 'wind', 'categorical.4'],
  ['other', 'info', 'neutral'],
]

/** Последние N суток по полю времени — условие слоя, считается на каждый тайл. */
const lastDays = (field: string, days: number) => ({
  field,
  op: 'relative' as const,
  value: { unit: 'day' as const, from: 1 - days, to: 0 },
})

/**
 * Слои карты обстановки (04-domain-pack-emergency.md «Дашборды и карты»): снизу вверх —
 * зоны риска, объекты защиты, ПВР, гидропосты, силы и средства, происшествия за трое
 * суток, сообщения об опасных явлениях за неделю.
 */
const PACK_LAYERS: readonly PackLayer[] = [
  {
    key: 'layer.risk_zones',
    dataset: 'risk_zones',
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
      polygon: { fillOpacity: 0.25, outline: { width: 1, color: 'auto' } },
      label: { field: 'name', minZoom: 10 },
      popup: {
        title: '{{name}}',
        fields: ['hazard', 'risk_level', 'season', 'area_km2'],
        actions: ['open'],
      },
    },
  },
  {
    key: 'layer.protected_objects',
    dataset: 'protected_objects',
    name: 'Объекты защиты',
    visible: false,
    style: {
      geometry: 'point',
      renderer: {
        kind: 'categorized',
        field: 'object_type',
        categories: OBJECT_KINDS.map(([value, icon, color]) => ({ value, icon, color })),
        other: { color: 'other' },
      },
      point: { shape: 'icon', size: 18 },
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
    key: 'layer.shelters',
    dataset: 'shelters',
    name: 'Пункты временного размещения',
    visible: true,
    style: {
      geometry: 'point',
      renderer: {
        kind: 'categorized',
        field: 'status',
        categories: [
          { value: 'ready', icon: 'tent', color: 'success' },
          { value: 'deployed', icon: 'tent', color: 'warning' },
          { value: 'not_ready', icon: 'tent', color: 'danger' },
        ],
        other: { color: 'other' },
      },
      point: { shape: 'icon', size: 18 },
      cluster: { enabled: true, radius: 50 },
      label: { field: 'name', minZoom: 11 },
      popup: {
        title: '{{name}}',
        fields: ['status', 'capacity', 'occupied', 'responsible', 'phone'],
        actions: ['open'],
      },
    },
  },
  {
    key: 'layer.hydro_posts',
    dataset: 'hydro_posts',
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
    key: 'layer.forces',
    dataset: 'forces',
    name: 'Силы и средства',
    visible: false,
    style: {
      geometry: 'point',
      renderer: { kind: 'simple', color: 'accent', icon: 'truck' },
      point: { shape: 'icon', size: 18 },
      label: { field: 'name', minZoom: 10 },
      popup: {
        title: '{{name}}',
        fields: ['resource_type', 'quantity', 'ready', 'unit'],
        actions: ['open'],
      },
    },
  },
  {
    key: 'layer.incidents',
    dataset: 'incidents',
    name: 'Происшествия за трое суток',
    visible: true,
    editable: true,
    style: {
      geometry: 'point',
      renderer: { kind: 'simple', color: 'danger', icon: 'siren' },
      point: { shape: 'icon', size: 16 },
      cluster: { enabled: true, radius: 50 },
      filter: lastDays('occurred_at', 3),
      popup: {
        title: '{{description}}',
        fields: ['occurred_at', 'type_code', 'territory', 'injured', 'deaths', 'scale'],
        actions: ['open', 'instruction'],
      },
    },
  },
  {
    key: 'layer.hazard_messages',
    dataset: 'hazard_messages',
    name: 'Сообщения об опасных явлениях',
    visible: true,
    editable: true,
    style: {
      geometry: 'point',
      renderer: {
        kind: 'categorized',
        field: 'hazard',
        categories: HAZARD_ICONS.map(([value, icon, color]) => ({ value, icon, color })),
        other: { color: 'other' },
      },
      point: { shape: 'icon', size: 20 },
      filter: lastDays('occurred_at', 7),
      label: { field: 'magnitude', minZoom: 7 },
      popup: {
        title: '{{title}}',
        fields: ['source', 'occurred_at', 'magnitude', 'alert_level', 'territory', 'status'],
        actions: ['open', 'instruction'],
      },
    },
  },
]

const MAP_KEY = 'map.situation'

/** Слои пакета и карта «Обстановка ЧС» в пространстве пакета; существующее не трогается. */
export async function ensureMap(
  pack: PackContext,
  datasets: ReadonlyMap<string, string>,
): Promise<{ mapId: string; layers: Map<string, string> }> {
  const layers = new Map<string, string>()
  const created: string[] = []
  for (const spec of PACK_LAYERS) {
    const datasetId = datasets.get(spec.dataset)
    if (!datasetId) continue
    const existing = await findPackObject('layer', spec.key)
    if (existing) {
      layers.set(spec.key, existing)
      continue
    }
    const id = await db().transaction(async (tx) => {
      const layerId = await LayerService.create(tx, pack.ctx, {
        name: spec.name,
        spaceId: pack.spaceId,
        datasetId,
        style: LayerStyle.parse({ version: 1, ...spec.style }),
        editable: spec.editable ?? false,
        moderated: false,
      })
      await markPackObject(tx, pack.ctx, layerId, spec.key)
      return layerId
    })
    layers.set(spec.key, id)
    created.push(spec.key)
  }
  const found = await findPackObject('map', MAP_KEY)
  const mapId =
    found ??
    (await db().transaction(async (tx) => {
      const entries: MapLayerEntry[] = PACK_LAYERS.flatMap((spec) => {
        const layerId = layers.get(spec.key)
        return layerId ? [{ layerId, visible: spec.visible, opacity: 1, group: null }] : []
      })
      const id = await MapService.create(tx, pack.ctx, {
        name: 'Обстановка ЧС',
        spaceId: pack.spaceId,
        parentId: null,
        spec: MapSpec.parse({
          layers: entries,
          camera: { center: [70.6, 38.75], zoom: 6, bearing: 0, pitch: 0 },
        }),
      })
      await markPackObject(tx, pack.ctx, id, MAP_KEY)
      return id
    }))
  pack.log('карта обстановки готова', { created })
  return { mapId, layers }
}
