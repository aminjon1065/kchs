import {
  DatasetCreateInput,
  type DatasetFieldInput,
  type DatasetFieldPatch,
  type FieldFormat,
  type FieldSemantic,
  type LangText,
  type StoredFieldType,
} from '@kchs/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { ObjectService } from '~/kernel/objects/service.js'
import { DatasetService } from '~/modules/data/domain/dataset-service.js'
import { RowService } from '~/modules/data/domain/row-service.js'
import { SchemaService } from '~/modules/data/domain/schema-service.js'
import { qualified } from '~/modules/data/infra/physical.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { findPackObject, markPackObject, type PackContext } from './context.js'

type FieldExtra = Partial<Omit<DatasetFieldInput, 'key' | 'label' | 'type' | 'semantic'>>

/** Поле датасета пакета: подписи ru и en, тип и семантика — как у генератора демо-данных. */
function field(
  key: string,
  ru: string,
  en: string,
  type: StoredFieldType,
  semantic: FieldSemantic,
  extra: FieldExtra = {},
): DatasetFieldInput {
  return {
    key,
    label: { ru, en },
    type,
    semantic,
    required: false,
    unique: false,
    indexed: false,
    sensitive: false,
    readOnly: false,
    nullable: !extra.required,
    order: 0,
    ...extra,
  } as DatasetFieldInput
}

const options = (items: ReadonlyArray<readonly [string, string, string?]>) =>
  items.map(([value, ru, color]) => ({
    value,
    label: { ru } as LangText,
    ...(color ? { color } : {}),
  }))

const LAT = field('lat', 'Широта', 'Latitude', 'number', 'dimension', { format: { precision: 5 } })
const LON = field('lon', 'Долгота', 'Longitude', 'number', 'dimension', {
  format: { precision: 5 },
})
const TERRITORY = field('territory', 'Территория', 'Territory', 'territory', 'territory')
const GEOMETRY = field('geometry', 'Геометрия', 'Geometry', 'geometry', 'geometry')
const POINT = field('geometry', 'Местоположение', 'Location', 'geometry', 'geometry', {
  geometryType: 'point',
})
const DATE: FieldFormat = { dateFormat: 'yyyy-MM-dd' }
const DATETIME: FieldFormat = { dateFormat: 'yyyy-MM-dd HH:mm' }

/** Справочник видов происшествий — тот же, что у генератора демо-данных (ADR-0054). */
export const INCIDENT_KINDS: ReadonlyArray<readonly [string, string, string]> = [
  ['FLOOD', 'Паводок, наводнение', 'Природные'],
  ['MUDFLOW', 'Сель', 'Природные'],
  ['LANDSLIDE', 'Оползень', 'Природные'],
  ['AVALANCHE', 'Снежная лавина', 'Природные'],
  ['ROCKFALL', 'Камнепад, обвал', 'Природные'],
  ['EARTHQUAKE', 'Землетрясение', 'Природные'],
  ['STORM', 'Сильный ветер, ураган', 'Природные'],
  ['HAIL', 'Град, ливень', 'Природные'],
  ['WILDFIRE', 'Природный пожар', 'Природные'],
  ['FIRE', 'Пожар в здании', 'Техногенные'],
  ['ROAD', 'Дорожно-транспортное происшествие', 'Техногенные'],
  ['GAS', 'Взрыв бытового газа', 'Техногенные'],
  ['POWER', 'Авария на электросетях', 'Техногенные'],
  ['WATER', 'Авария на водопроводе', 'Техногенные'],
  ['COLLAPSE', 'Обрушение здания, сооружения', 'Техногенные'],
  ['DAM', 'Авария на гидротехническом сооружении', 'Техногенные'],
  ['CHEMICAL', 'Выброс опасных химических веществ', 'Техногенные'],
  ['INFECTION', 'Вспышка инфекционного заболевания', 'Биолого-социальные'],
  ['EPIZOOTIC', 'Эпизоотия', 'Биолого-социальные'],
  ['POISONING', 'Массовое отравление', 'Биолого-социальные'],
  ['DROWNING', 'Происшествие на воде', 'Биолого-социальные'],
  ['MOUNTAIN', 'Происшествие в горах', 'Биолого-социальные'],
]

/** Виды опасных явлений в сообщениях лент и служб. */
export const HAZARDS = options([
  ['earthquake', 'Землетрясение', 'danger'],
  ['flood', 'Наводнение, паводок', 'info'],
  ['mudflow', 'Сель', 'categorical.5'],
  ['landslide', 'Оползень', 'categorical.6'],
  ['avalanche', 'Лавина', 'categorical.2'],
  ['fire', 'Пожар, термическая аномалия', 'warning'],
  ['drought', 'Засуха', 'categorical.8'],
  ['cyclone', 'Тропический циклон', 'purple'],
  ['volcano', 'Извержение вулкана', 'categorical.3'],
  ['storm', 'Сильный ветер, ураган', 'categorical.4'],
  ['other', 'Другое', 'neutral'],
])

/** Решение дежурного по сообщению: журнал решений — история строки. */
export const MESSAGE_STATUSES = options([
  ['new', 'Новое', 'danger'],
  ['reviewed', 'Рассмотрено', 'info'],
  ['noted', 'Принято к сведению', 'neutral'],
  ['incident', 'Заведено происшествие', 'warning'],
  ['dismissed', 'Не касается, ложное', 'neutral'],
])

export interface PackDataset {
  /** Устойчивый ключ пакета; у демо-совместимых — ещё и `meta.demo` генератора. */
  key: string
  demo?: string
  space: 'org' | 'pack'
  name: string
  description: string
  kind: 'table' | 'reference'
  fields: DatasetFieldInput[]
  primaryKey: string[]
  timeField?: string
  territoryField?: string
  rowEvents?: boolean
  /** Поля пакета поверх демо-схемы: добавляются и к уже загруженному датасету. */
  extra?: DatasetFieldInput[]
  /** Правки полей демо-схемы: форма заводит происшествие без номера. */
  patches?: Array<{ key: string; patch: DatasetFieldPatch }>
  lookups?: Array<{ field: string; dataset: string; keyField: string; labelField: string }>
}

/**
 * Реестры пакета (04-domain-pack-emergency.md «Датасеты и слои»). Семь первых
 * совпадают со схемами генератора демо-данных поле в поле (`apps/engine/kchs_engine/demo`):
 * генератор загружает строки в датасет с тем же `meta.demo`, в каком бы порядке ни
 * ставились пакет и демо-данные. Они живут в «Общем» — реестры общего пользования;
 * оперативные реестры штаба — в пространстве пакета.
 */
export const PACK_DATASETS: readonly PackDataset[] = [
  {
    key: 'incident_types',
    demo: 'incident_types',
    space: 'org',
    name: 'Типы происшествий',
    description: 'Классификатор видов чрезвычайных ситуаций и происшествий по группам.',
    kind: 'reference',
    fields: [
      field('code', 'Код', 'Code', 'identifier', 'identifier', { required: true }),
      field('name', 'Название', 'Name', 'text', 'dimension', { required: true }),
      field('group_name', 'Группа', 'Group', 'text', 'category', { required: true }),
    ],
    primaryKey: ['code'],
  },
  {
    key: 'hydro_posts',
    demo: 'hydro_posts',
    space: 'org',
    name: 'Гидропосты',
    description: 'Посты наблюдения за уровнем воды: река, район, опасный уровень.',
    kind: 'reference',
    fields: [
      field('code', 'Код', 'Code', 'identifier', 'identifier', { required: true }),
      field('name', 'Название', 'Name', 'text', 'dimension', { required: true }),
      field('river', 'Река', 'River', 'text', 'category'),
      TERRITORY,
      LAT,
      LON,
      field('danger_level_cm', 'Опасный уровень, см', 'Danger level, cm', 'integer', 'measure'),
      GEOMETRY,
    ],
    primaryKey: ['code'],
    territoryField: 'territory',
  },
  {
    key: 'incidents',
    demo: 'incidents',
    space: 'org',
    name: 'Происшествия',
    description:
      'Реестр происшествий и чрезвычайных ситуаций: время, вид, район, пострадавшие, ущерб. Пополняется суточными сводками регионов и дежурным.',
    kind: 'table',
    fields: [
      field('code', 'Номер', 'Number', 'identifier', 'identifier', { required: true }),
      field('occurred_at', 'Дата и время', 'Date and time', 'datetime', 'time', {
        required: true,
        format: { dateFormat: 'yyyy-MM-dd HH:mm' },
      }),
      field('type_code', 'Тип', 'Type', 'text', 'category', { required: true }),
      field('territory', 'Территория', 'Territory', 'territory', 'territory', { required: true }),
      LAT,
      LON,
      field('damage', 'Ущерб, сомони', 'Damage, TJS', 'money', 'measure', {
        format: { precision: 2, currency: 'TJS', thousands: true },
      }),
      field('injured', 'Пострадавшие', 'Injured', 'integer', 'measure'),
      field('deaths', 'Погибшие', 'Deaths', 'integer', 'measure'),
      field('description', 'Описание', 'Description', 'text', 'text'),
      GEOMETRY,
    ],
    primaryKey: ['code'],
    timeField: 'occurred_at',
    territoryField: 'territory',
    rowEvents: true,
    extra: [
      field('scale', 'Масштаб', 'Scale', 'select', 'category', {
        options: options([
          ['local', 'Локальный'],
          ['municipal', 'Местный'],
          ['regional', 'Региональный'],
          ['national', 'Республиканский'],
          ['transboundary', 'Трансграничный'],
        ]),
      }),
      field('evacuated', 'Эвакуировано, чел.', 'Evacuated', 'integer', 'measure'),
      field('source', 'Источник записи', 'Record source', 'select', 'category', {
        options: options([
          ['summary', 'Суточная сводка'],
          ['report', 'Донесение'],
          ['duty', 'Дежурный'],
          ['feed', 'Лента опасных явлений'],
          ['import', 'Импорт'],
        ]),
      }),
      field('unit', 'Подразделение', 'Reporting unit', 'unit', 'dimension'),
      field('report_date', 'Дата сводки', 'Report date', 'date', 'time', { format: DATE }),
      field('reported_by', 'Кто сообщил', 'Reported by', 'user', 'dimension'),
      field('submitted_at', 'Время сдачи', 'Submitted at', 'datetime', 'time'),
      // Время реагирования сил (ADR-0157): вызов, выезд и прибытие первых сил на место
      field('called_at', 'Время вызова', 'Call received', 'datetime', 'time', { format: DATETIME }),
      field('dispatched_at', 'Время выезда', 'Dispatched', 'datetime', 'time', {
        format: DATETIME,
      }),
      field('arrived_at', 'Время прибытия', 'Arrived on scene', 'datetime', 'time', {
        format: DATETIME,
      }),
    ],
    // Строку из суточной сводки номер не спрашивает: ключ остаётся, пустые ключи не конфликтуют
    patches: [{ key: 'code', patch: { required: false } }],
    lookups: [
      { field: 'type_code', dataset: 'incident_types', keyField: 'code', labelField: 'name' },
    ],
  },
  {
    key: 'water_levels',
    demo: 'water_levels',
    space: 'org',
    name: 'Уровни воды',
    description: 'Ежедневные наблюдения гидропостов: уровень, расход, превышение опасного уровня.',
    kind: 'table',
    fields: [
      field('observed_on', 'Дата', 'Date', 'date', 'time', { required: true, format: DATE }),
      field('post_code', 'Гидропост', 'Gauging station', 'text', 'category', { required: true }),
      TERRITORY,
      field('level_cm', 'Уровень воды, см', 'Water level, cm', 'integer', 'measure'),
      field('discharge', 'Расход воды, м³/с', 'Discharge, m³/s', 'number', 'measure', {
        format: { precision: 1 },
      }),
      field('above_danger', 'Выше опасного уровня', 'Above danger level', 'boolean', 'category'),
    ],
    primaryKey: ['observed_on', 'post_code'],
    timeField: 'observed_on',
    territoryField: 'territory',
    rowEvents: true,
    lookups: [{ field: 'post_code', dataset: 'hydro_posts', keyField: 'code', labelField: 'name' }],
  },
  {
    key: 'protected_objects',
    demo: 'protected_objects',
    space: 'org',
    name: 'Объекты защиты',
    description: 'Школы, больницы, ПВР, мосты, дамбы и другие объекты: вместимость и состояние.',
    kind: 'table',
    fields: [
      field('code', 'Код', 'Code', 'identifier', 'identifier', { required: true }),
      field('name', 'Название', 'Name', 'text', 'dimension', { required: true }),
      field('object_type', 'Тип', 'Type', 'text', 'category', { required: true }),
      TERRITORY,
      field('capacity', 'Вместимость, чел.', 'Capacity, people', 'integer', 'measure'),
      field('built_year', 'Год постройки', 'Year built', 'integer', 'dimension'),
      field(
        'seismic_rating',
        'Сейсмостойкость, баллов',
        'Seismic resistance, points',
        'integer',
        'dimension',
      ),
      field('condition', 'Состояние', 'Condition', 'text', 'category'),
      GEOMETRY,
    ],
    primaryKey: ['code'],
    territoryField: 'territory',
  },
  {
    key: 'risk_zones',
    demo: 'risk_zones',
    space: 'org',
    name: 'Зоны риска',
    description: 'Зоны подтопления, селе-, оползне- и лавиноопасные участки, зоны сотрясений.',
    kind: 'table',
    fields: [
      field('code', 'Код', 'Code', 'identifier', 'identifier', { required: true }),
      field('name', 'Название', 'Name', 'text', 'dimension', { required: true }),
      field('hazard', 'Тип угрозы', 'Hazard', 'text', 'category', { required: true }),
      field('risk_level', 'Уровень риска', 'Risk level', 'text', 'category', { required: true }),
      TERRITORY,
      field('season', 'Сезонность', 'Season', 'text', 'category'),
      field('method', 'Метод оценки', 'Assessment method', 'text', 'category'),
      field('area_km2', 'Площадь, км²', 'Area, km²', 'number', 'measure', {
        format: { precision: 2 },
      }),
      field('assessed_on', 'Дата оценки', 'Assessment date', 'date', 'time', { format: DATE }),
      GEOMETRY,
    ],
    primaryKey: ['code'],
    timeField: 'assessed_on',
    territoryField: 'territory',
  },
  {
    key: 'hazard_messages',
    space: 'pack',
    name: 'Сообщения об опасных явлениях',
    description:
      'Сообщения мировых лент (GDACS, USGS, EMSC, NASA FIRMS) и национальных служб с привязкой к району и решением дежурного. Журнал решений — история строки.',
    kind: 'table',
    fields: [
      field('code', 'Код', 'Code', 'identifier', 'identifier', { required: true }),
      field('source', 'Источник', 'Source', 'select', 'category', {
        required: true,
        options: options([
          ['gdacs', 'GDACS'],
          ['usgs', 'USGS'],
          ['emsc', 'EMSC'],
          ['firms', 'NASA FIRMS'],
          ['hydromet', 'Агентство по гидрометеорологии'],
          ['geophysics', 'Геофизическая служба'],
          ['region', 'Региональное управление'],
        ]),
      }),
      field('hazard', 'Явление', 'Hazard', 'select', 'category', {
        required: true,
        options: HAZARDS,
      }),
      field('title', 'Сообщение', 'Message', 'text', 'text', { required: true }),
      field('occurred_at', 'Время', 'Time', 'datetime', 'time', {
        required: true,
        format: { dateFormat: 'yyyy-MM-dd HH:mm' },
      }),
      field('magnitude', 'Магнитуда', 'Magnitude', 'number', 'measure', {
        format: { precision: 1 },
      }),
      field('depth_km', 'Глубина, км', 'Depth, km', 'number', 'measure', {
        format: { precision: 0 },
      }),
      field('alert_level', 'Уровень тревоги', 'Alert level', 'select', 'category', {
        options: options([
          ['green', 'Зелёный', 'success'],
          ['orange', 'Оранжевый', 'warning'],
          ['red', 'Красный', 'danger'],
        ]),
      }),
      field('frp', 'Мощность очага, МВт', 'Fire radiative power, MW', 'number', 'measure', {
        format: { precision: 1 },
      }),
      field('territory', 'Район', 'District', 'territory', 'territory'),
      field('url', 'Подробности', 'Details', 'url', 'text'),
      field('status', 'Решение', 'Decision', 'select', 'category', {
        required: true,
        options: MESSAGE_STATUSES,
        default: 'new',
      }),
      field('decision', 'Комментарий дежурного', 'Duty officer note', 'long_text', 'text'),
      POINT,
    ],
    primaryKey: ['code'],
    timeField: 'occurred_at',
    territoryField: 'territory',
    rowEvents: true,
  },
  {
    key: 'shelters',
    space: 'pack',
    name: 'Пункты временного размещения',
    description: 'ПВР: вместимость, размещено, готовность, ответственный и связь.',
    kind: 'table',
    fields: [
      field('code', 'Код', 'Code', 'identifier', 'identifier', { required: true }),
      field('name', 'Название', 'Name', 'text', 'dimension', { required: true }),
      field('territory', 'Район', 'District', 'territory', 'territory'),
      field('address', 'Адрес', 'Address', 'text', 'text'),
      field('capacity', 'Вместимость, чел.', 'Capacity, people', 'integer', 'measure'),
      field('occupied', 'Размещено, чел.', 'Accommodated, people', 'integer', 'measure', {
        default: 0,
      }),
      field('status', 'Состояние', 'Status', 'select', 'category', {
        options: options([
          ['ready', 'В готовности', 'success'],
          ['deployed', 'Развёрнут', 'warning'],
          ['not_ready', 'Не готов', 'danger'],
        ]),
        default: 'ready',
      }),
      field('responsible', 'Ответственный', 'Responsible', 'text', 'text'),
      field('phone', 'Телефон', 'Phone', 'phone', 'text'),
      POINT,
    ],
    primaryKey: ['code'],
    territoryField: 'territory',
  },
  {
    key: 'forces',
    space: 'pack',
    name: 'Силы и средства',
    description: 'Личный состав и техника подразделений: по штату и в готовности, дислокация.',
    kind: 'table',
    fields: [
      field('code', 'Код', 'Code', 'identifier', 'identifier', { required: true }),
      field('unit', 'Подразделение', 'Unit', 'unit', 'dimension'),
      field('resource_type', 'Вид', 'Kind', 'select', 'category', {
        options: options([
          ['personnel', 'Личный состав'],
          ['rescue', 'Спасательная техника'],
          ['fire', 'Пожарная техника'],
          ['engineering', 'Инженерная техника'],
          ['boats', 'Плавсредства'],
          ['uav', 'Беспилотники'],
          ['power', 'Мобильные электростанции'],
          ['shelter', 'Палатки и имущество ПВР'],
        ]),
      }),
      field('name', 'Наименование', 'Name', 'text', 'dimension', { required: true }),
      field('quantity', 'По штату', 'Authorised', 'integer', 'measure'),
      field('ready', 'В готовности', 'Ready', 'integer', 'measure'),
      field('territory', 'Дислокация', 'Location', 'territory', 'territory'),
      POINT,
    ],
    primaryKey: ['code'],
    territoryField: 'territory',
  },
  {
    key: 'warnings_log',
    space: 'pack',
    name: 'Журнал оповещения населения',
    description:
      'Оповещение, проведённое вне системы (сирены, SMS, радио, подворный обход): кто, когда, где, охват.',
    kind: 'table',
    fields: [
      field('code', 'Номер', 'Number', 'identifier', 'identifier', { required: true }),
      field('sent_at', 'Время', 'Time', 'datetime', 'time', {
        required: true,
        format: { dateFormat: 'yyyy-MM-dd HH:mm' },
      }),
      field('territory', 'Район', 'District', 'territory', 'territory'),
      field('zone', 'Зона оповещения', 'Warning zone', 'text', 'text'),
      field('channel', 'Способ', 'Channel', 'select', 'category', {
        options: options([
          ['siren', 'Сирены'],
          ['sms', 'SMS-рассылка'],
          ['telegram', 'Telegram-канал'],
          ['radio', 'Радио'],
          ['tv', 'Телевидение'],
          ['loudspeaker', 'Громкоговорители'],
          ['door', 'Подворный обход'],
        ]),
      }),
      field('coverage', 'Охват, чел.', 'Reach, people', 'integer', 'measure'),
      field('message', 'Текст оповещения', 'Message', 'long_text', 'text'),
      field('responsible', 'Ответственный', 'Responsible', 'text', 'text'),
    ],
    primaryKey: ['code'],
    timeField: 'sent_at',
    territoryField: 'territory',
  },
  {
    key: 'duty_roster',
    space: 'pack',
    name: 'График дежурств',
    description: 'Суточные смены оперативно-дежурной службы: начальник смены, дежурный, помощник.',
    kind: 'table',
    fields: [
      field('duty_date', 'Дата', 'Date', 'date', 'time', { required: true, format: DATE }),
      field('shift_head', 'Начальник смены', 'Shift head', 'user', 'dimension'),
      field('duty_officer', 'Оперативный дежурный', 'Duty officer', 'user', 'dimension'),
      field('assistant', 'Помощник дежурного', 'Assistant', 'user', 'dimension'),
      field('phone', 'Телефон дежурной службы', 'Duty phone', 'phone', 'text'),
      field('note', 'Примечание', 'Note', 'text', 'text'),
    ],
    primaryKey: ['duty_date'],
    timeField: 'duty_date',
  },
]

/** Датасет генератора демо-данных в пространстве по `meta.demo`. */
async function demoDataset(spaceId: string, demo: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.type, 'dataset'),
        eq(objects.spaceId, spaceId),
        isNull(objects.deletedAt),
        sql`${objects.meta}->>'demo' = ${demo}`,
      ),
    )
    .limit(1)
  return row?.id ?? null
}

async function create(pack: PackContext, spec: PackDataset): Promise<string> {
  const spaceId = spec.space === 'org' ? pack.orgSpaceId : pack.spaceId
  const input = DatasetCreateInput.parse({
    name: spec.name,
    description: spec.description,
    spaceId,
    kind: spec.kind,
    fields: [...spec.fields, ...(spec.extra ?? [])],
    primaryKey: spec.primaryKey,
    timeField: spec.timeField ?? null,
    territoryField: spec.territoryField ?? null,
    settings: { rowEvents: spec.rowEvents ?? false },
  })
  return db().transaction(async (tx) => {
    const id = await DatasetService.create(tx, pack.ctx, input)
    // Ключ генератора — чтобы демо-данные легли в этот же датасет
    if (spec.demo) {
      await ObjectService.update(
        tx,
        pack.ctx,
        id,
        { meta: { demo: spec.demo }, mergeMeta: true },
        { silent: true },
      )
    }
    await markPackObject(tx, pack.ctx, id, `dataset.${spec.key}`)
    return id
  })
}

/**
 * Досводка существующего датасета до схемы пакета: поля пакета, правки полей,
 * справочники и события строк — только то, чего ещё нет.
 */
async function align(
  pack: PackContext,
  spec: PackDataset,
  id: string,
  ids: ReadonlyMap<string, string>,
): Promise<string[]> {
  const storage = await DatasetService.storage(id)
  const byKey = new Map(storage.fields.map((item) => [item.key, item]))
  const changes: string[] = []
  await db().transaction(async (tx) => {
    for (const item of spec.extra ?? []) {
      if (byKey.has(item.key)) continue
      await SchemaService.addField(tx, pack.ctx, id, item)
      changes.push(`+${item.key}`)
    }
    for (const { key, patch } of spec.patches ?? []) {
      const current = byKey.get(key)
      if (!current) continue
      if (patch.required !== undefined && current.required === patch.required) continue
      await SchemaService.updateField(tx, pack.ctx, id, key, patch)
      changes.push(`~${key}`)
    }
    for (const lookup of spec.lookups ?? []) {
      const current = byKey.get(lookup.field)
      const target = ids.get(lookup.dataset)
      if (!current || !target || current.lookup?.datasetId === target) continue
      await SchemaService.updateField(tx, pack.ctx, id, lookup.field, {
        lookup: { datasetId: target, keyField: lookup.keyField, labelField: lookup.labelField },
      })
      changes.push(`lookup:${lookup.field}`)
    }
    if (spec.rowEvents && !storage.settings.rowEvents) {
      await SchemaService.update(tx, pack.ctx, id, { settings: { rowEvents: true } })
      changes.push('rowEvents')
    }
  })
  return changes
}

/** Датасеты пакета по ключам: найденные, принятые из демо-данных или новые. */
export async function ensureDatasets(pack: PackContext): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  const created: string[] = []
  const adopted: string[] = []
  for (const spec of PACK_DATASETS) {
    let id = await findPackObject('dataset', `dataset.${spec.key}`)
    if (!id && spec.demo) {
      id = await demoDataset(pack.orgSpaceId, spec.demo)
      if (id) {
        const found = id
        await db().transaction((tx) => markPackObject(tx, pack.ctx, found, `dataset.${spec.key}`))
        adopted.push(spec.key)
      }
    }
    if (!id) {
      id = await create(pack, spec)
      created.push(spec.key)
    }
    ids.set(spec.key, id)
  }
  const aligned: Record<string, string[]> = {}
  for (const spec of PACK_DATASETS) {
    const id = ids.get(spec.key) as string
    const changes = await align(pack, spec, id, ids)
    if (changes.length > 0) aligned[spec.key] = changes
  }
  pack.log('датасеты пакета ЧС готовы', { created, adopted, aligned })
  return ids
}

/** Число живых строк датасета — для заполнения пустых реестров. */
export async function rowCount(datasetId: string): Promise<number> {
  const storage = await DatasetService.storage(datasetId)
  const [row] = await db().execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM ${sql.raw(qualified(storage.table))} WHERE _deleted_at IS NULL`,
  )
  return Number(row?.count ?? 0)
}

/** Строки пачками: одна версия датасета на пачку, события строк — только у малых пачек. */
export async function insertRows(
  pack: PackContext,
  datasetId: string,
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  let inserted = 0
  for (let at = 0; at < rows.length; at += 500) {
    const chunk = rows.slice(at, at + 500).map((values) => ({ values }))
    inserted += (await RowService.insert(pack.ctx, datasetId, chunk)).length
  }
  return inserted
}

/** Справочник видов происшествий на чистой установке (демо-генератор грузит свой). */
export async function ensureIncidentKinds(pack: PackContext, datasetId: string): Promise<number> {
  if ((await rowCount(datasetId)) > 0) return 0
  return insertRows(
    pack,
    datasetId,
    INCIDENT_KINDS.map(([code, name, group]) => ({ code, name, group_name: group })),
  )
}
