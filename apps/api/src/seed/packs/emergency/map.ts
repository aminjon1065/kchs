import {
  LayerStyle,
  type LayerStyleInput,
  type LayerSystemSource,
  type MapLayerEntry,
  MapSpec,
} from '@kchs/contracts'
import { LayerService } from '~/modules/gis/domain/layer-service.js'
import { MapService } from '~/modules/gis/domain/map-service.js'
import { db } from '~/shared/db/client.js'
import { findPackObject, markPackObject, type PackContext } from './context.js'

interface PackLayer {
  key: string
  /** Датасет пакета — или системный датасет с правами смотрящего (ADR-0223). */
  dataset?: string
  systemSource?: LayerSystemSource
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
 * суток, сообщения об опасных явлениях за неделю, донесения с местом на карте. На
 * установленном пакете недостающий слой досоздаётся, а карта не меняется (N90, N109):
 * на карту его добавляет администратор.
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
    // Живое местоположение техники и групп (ADR-0203): цвет — связь
    key: 'layer.forces_live',
    dataset: 'forces_live',
    name: 'Техника и группы',
    visible: true,
    style: {
      geometry: 'point',
      renderer: {
        kind: 'categorized',
        field: 'link',
        categories: [
          { value: 'online', icon: 'truck', color: 'success' },
          { value: 'stale', icon: 'truck', color: 'warning' },
        ],
        other: { color: 'other' },
      },
      point: { shape: 'icon', size: 18 },
      label: { field: 'name', minZoom: 10 },
      popup: {
        title: '{{name}}',
        fields: ['kind', 'forces_code', 'unit', 'seen_at', 'speed', 'battery', 'link'],
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
      // Только случившееся: строка с будущим временем — ошибка ввода (демо-набор — до конца года)
      filter: {
        and: [lastDays('occurred_at', 3), { field: 'occurred_at', op: 'lte', value: '@now' }],
      },
      popup: {
        title: '{{description}}',
        // Строка сводки без указанного места стоит в центре района (ADR-0157)
        fields: [
          'occurred_at',
          'type_code',
          'territory',
          'injured',
          'deaths',
          'scale',
          'arrived_at',
          'location_approx',
        ],
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
  {
    // Донесения с местом на карте (ADR-0223, N161): строки — по правам смотрящего на
    // документ и его грифу, поэтому слой — над системным датасетом, а не копией строк
    key: 'layer.situation_reports',
    systemSource: 'document_places',
    name: 'Донесения',
    visible: true,
    style: {
      geometry: 'point',
      renderer: { kind: 'simple', color: 'warning', icon: 'megaphone' },
      point: { shape: 'icon', size: 18 },
      filter: { field: 'type_key', op: 'eq', value: 'situation_report' },
      label: { field: 'reg_number', minZoom: 10 },
      popup: {
        title: '{{subject}}',
        fields: ['type_name', 'reg_number', 'reg_date', 'territory', 'id'],
        actions: [],
      },
    },
  },
]

const MAP_KEY = 'map.situation'

/**
 * Слои пакета и карта «Обстановка ЧС» в пространстве пакета; существующее не трогается.
 * Слой, которого не было в прежней версии пакета (слой «Донесения», ADR-0223), на уже
 * установленной карте встаёт в конец списка — правки карты пользователями остаются.
 */
export async function ensureMap(
  pack: PackContext,
  datasets: ReadonlyMap<string, string>,
): Promise<{ mapId: string; layers: Map<string, string> }> {
  const layers = new Map<string, string>()
  const created: string[] = []
  for (const spec of PACK_LAYERS) {
    const datasetId = spec.dataset ? datasets.get(spec.dataset) : undefined
    if (!datasetId && !spec.systemSource) continue
    const existing = await findPackObject('layer', spec.key)
    if (existing) {
      layers.set(spec.key, existing)
      continue
    }
    const id = await db().transaction(async (tx) => {
      const layerId = await LayerService.create(tx, pack.ctx, {
        name: spec.name,
        spaceId: pack.spaceId,
        ...(datasetId ? { datasetId } : { systemSource: spec.systemSource }),
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
  if (found && created.length > 0) await appendLayers(pack, found, created, layers)
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

/** Новые слои пакета — в конец уже установленной карты, если их там ещё нет. */
async function appendLayers(
  pack: PackContext,
  mapId: string,
  created: readonly string[],
  layers: ReadonlyMap<string, string>,
): Promise<void> {
  await db().transaction(async (tx) => {
    const map = await MapService.get(pack.ctx, mapId)
    const present = new Set(map.spec.layers.map((entry) => entry.layerId))
    const added: MapLayerEntry[] = PACK_LAYERS.flatMap((spec) => {
      const layerId = layers.get(spec.key)
      if (!layerId || !created.includes(spec.key) || present.has(layerId)) return []
      return [{ layerId, visible: spec.visible, opacity: 1, group: null }]
    })
    if (added.length === 0) return
    await MapService.update(tx, pack.ctx, mapId, {
      spec: MapSpec.parse({ ...map.spec, layers: [...map.spec.layers, ...added] }),
    })
  })
}
