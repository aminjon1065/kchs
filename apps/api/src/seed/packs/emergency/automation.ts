import {
  AlertCreateInput,
  type FeedConfigInput,
  FeedSourceCreateInput,
  FormCreateInput,
  RuleCreateInput,
  type RuleDefinition,
  ServiceAccountCreateInput,
} from '@kchs/contracts'
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { AlertService } from '~/modules/alerts/domain/alert-service.js'
import { RuleService } from '~/modules/automation/domain/rule-service.js'
import { syncRuleSchedule } from '~/modules/automation/domain/schedules.js'
import { FeedService } from '~/modules/data/domain/feed-service.js'
import { syncSourceSchedule } from '~/modules/data/domain/source-schedules.js'
import { FormService } from '~/modules/forms/domain/form-service.js'
import { ServiceAccountService } from '~/modules/identity/domain/service-accounts.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { journals, rules, users } from '~/shared/db/schema/index.js'
import { findPackObject, markPackObject, type PackContext, staffOf, unitId } from './context.js'
import type { PackStructure } from './structure.js'

type Ids = ReadonlyMap<string, string>

/** Служебная учётная запись пакета (ADR-0130): от неё работают правила, формы и ленты. */
const SERVICE_NAME = 'Автоматизация штаба ЧС'

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

async function ensureServiceAccount(pack: PackContext, datasets: Ids): Promise<string> {
  const [existing] = await db()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.kind, 'service'), eq(users.displayName, SERVICE_NAME)))
    .limit(1)
  const id =
    existing?.id ??
    (await db().transaction((tx) =>
      ServiceAccountService.create(
        tx,
        pack.ctx,
        ServiceAccountCreateInput.parse({
          name: SERVICE_NAME,
          description:
            'Правила, формы сбора и ленты опасных явлений пакета ЧС: пишет происшествия, уровни воды и сообщения, уведомляет штаб.',
          roleKeys: ['employee'],
          spaces: [
            { spaceId: pack.spaceId, role: 'editor' },
            { spaceId: pack.orgSpaceId, role: 'member' },
          ],
        }),
      ),
    ))
  // Правка реестров, в которые пишут формы, ленты и правила; выдача идемпотентна
  await db().transaction(async (tx) => {
    for (const key of ['incidents', 'water_levels', 'hazard_messages']) {
      const datasetId = datasets.get(key)
      if (!datasetId) continue
      await grantAccess(tx, pack.ctx, datasetId, [
        { principal: { type: 'user', id }, level: 'edit' },
      ])
    }
  })
  return id
}

// ── Формы сбора ───────────────────────────────────────────────────────────────

/** Ответственный за сдачу — первый сотрудник управления, не его глава (N48). */
async function responsibleOf(code: string): Promise<string | null> {
  const [first] = await staffOf([code], { heads: false })
  return first ?? null
}

async function ensureForms(
  pack: PackContext,
  datasets: Ids,
  writer: string,
  groups: PackStructure['groupIds'],
): Promise<string[]> {
  const created: string[] = []
  const regions = pack.demo ? ['RG-SUG', 'RG-KHA', 'RG-GBAO', 'RG-DRS'] : []
  const assignments = []
  for (const code of regions) {
    const id = await unitId(code)
    if (id) assignments.push({ kind: 'unit', id, responsibleId: await responsibleOf(code) })
  }
  const incidents = datasets.get('incidents') as string
  const specs = [
    {
      key: 'form.daily_summary',
      input: {
        name: 'Суточная сводка регионального управления',
        description:
          'Происшествия за календарные сутки — до 08:00 следующего дня, в выходные и праздники тоже. Нет происшествий — сводка сдаётся пустой.',
        spaceId: pack.spaceId,
        definition: {
          datasetId: incidents,
          layout: 'table',
          table: { minRows: 0, maxRows: 200 },
          fields: [
            { key: 'occurred_at', required: true, hint: 'Когда произошло' },
            { key: 'type_code', required: true, hint: null },
            { key: 'territory', required: true, hint: 'Район происшествия' },
            { key: 'injured', required: false, hint: null },
            { key: 'deaths', required: false, hint: null },
            { key: 'evacuated', required: false, hint: null },
            { key: 'damage', required: false, hint: 'Оценка, сомони' },
            { key: 'scale', required: false, hint: null },
            { key: 'description', required: false, hint: 'Что произошло, принятые меры' },
          ],
          auto: {
            unit: 'unit',
            period: 'report_date',
            author: 'reported_by',
            submittedAt: 'submitted_at',
          },
          schedule: {
            periodicity: 'daily',
            time: '08:00',
            dueMode: 'calendar',
            dueWorkingDays: 1,
            startsOn: day(-2),
            dueOn: null,
          },
          assignments,
          review: {
            enabled: true,
            // Группа есть и на чистой установке: её наполняет администратор
            reviewers: [`group:${groups.duty}`],
          },
          escalation: { enabled: true, afterWorkingDays: 0 },
        },
        runAs: writer,
        enabled: assignments.length > 0,
      },
    },
    {
      // Уровни воды — до соглашения с Гидрометом их вносит дежурная смена. В демо-мире
      // генератор уже заполнил все дни, поэтому форма остаётся выключенной
      key: 'form.water_levels',
      input: {
        name: 'Уровни воды на гидропостах',
        description:
          'Утренние наблюдения гидропостов: уровень, расход, превышение опасной отметки — до 08:00.',
        spaceId: pack.spaceId,
        definition: {
          datasetId: datasets.get('water_levels') as string,
          layout: 'table',
          table: { minRows: 0, maxRows: 100 },
          fields: [
            { key: 'post_code', required: true, hint: null },
            { key: 'level_cm', required: true, hint: null },
            { key: 'discharge', required: false, hint: null },
            { key: 'above_danger', required: false, hint: 'Уровень выше опасной отметки поста' },
          ],
          auto: { unit: null, period: 'observed_on', author: null, submittedAt: null },
          schedule: {
            periodicity: 'daily',
            time: '08:00',
            dueMode: 'calendar',
            dueWorkingDays: 1,
            startsOn: day(0),
            dueOn: null,
          },
          assignments: [],
          review: { enabled: false, reviewers: [] },
          escalation: { enabled: true, afterWorkingDays: 0 },
        },
        runAs: writer,
        enabled: false,
      },
    },
  ]
  for (const spec of specs) {
    if (await findPackObject('form', spec.key)) continue
    await db().transaction(async (tx) => {
      const id = await FormService.create(tx, pack.user, FormCreateInput.parse(spec.input))
      await markPackObject(tx, pack.ctx, id, spec.key)
    })
    created.push(spec.key)
  }
  return created
}

// ── Ленты опасных явлений ─────────────────────────────────────────────────────

/** Область мониторинга: Таджикистан и соседние районы, откуда приходят толчки и паводки. */
const REGION = { west: 64, south: 34, east: 78, north: 43 }
/** Сама страна — отбор термических аномалий (иначе лента — вся Азия). */
const COUNTRY_BBOX: [number, number, number, number] = [67.3, 36.6, 75.2, 41.1]

const path = (value: string, map?: Record<string, string>) => ({
  kind: 'path' as const,
  path: value,
  transform: 'auto' as const,
  ...(map ? { map } : {}),
})
const constant = (value: string) => ({ kind: 'const' as const, value })
const template = (value: string) => ({ kind: 'template' as const, template: value })

const QUAKE_COMMON = { geometryField: 'geometry', territoryField: 'territory', keyFields: ['code'] }

const FEEDS: ReadonlyArray<{
  key: string
  name: string
  description: string
  schedule: string
  feed: FeedConfigInput
}> = [
  {
    key: 'feed.usgs',
    name: 'USGS: землетрясения региона',
    description: 'Геологическая служба США, каталог FDSN: M3+ в области мониторинга за 30 суток.',
    schedule: '*/5 * * * *',
    feed: {
      url: `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=${REGION.south}&maxlatitude=${REGION.north}&minlongitude=${REGION.west}&maxlongitude=${REGION.east}&minmagnitude=3&orderby=time&limit=200`,
      format: 'geojson',
      geometry: { kind: 'feature' },
      mapping: [
        { field: 'code', value: template('usgs:{id}') },
        { field: 'source', value: constant('usgs') },
        { field: 'hazard', value: constant('earthquake') },
        { field: 'title', value: path('properties.title') },
        {
          field: 'occurred_at',
          value: { kind: 'path', path: 'properties.time', transform: 'epoch_ms' },
        },
        { field: 'magnitude', value: path('properties.mag') },
        { field: 'depth_km', value: path('geometry.coordinates.2') },
        { field: 'url', value: path('properties.url') },
      ],
      ...QUAKE_COMMON,
    },
  },
  {
    key: 'feed.emsc',
    name: 'EMSC: землетрясения региона',
    description:
      'Евро-Средиземноморский сейсмологический центр, каталог FDSN: M3+ в области мониторинга.',
    schedule: '*/5 * * * *',
    feed: {
      url: `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&minlat=${REGION.south}&maxlat=${REGION.north}&minlon=${REGION.west}&maxlon=${REGION.east}&minmag=3&limit=200`,
      format: 'geojson',
      geometry: { kind: 'feature' },
      mapping: [
        { field: 'code', value: template('emsc:{id}') },
        { field: 'source', value: constant('emsc') },
        { field: 'hazard', value: constant('earthquake') },
        { field: 'title', value: template('M {properties.mag} — {properties.flynn_region}') },
        { field: 'occurred_at', value: path('properties.time') },
        { field: 'magnitude', value: path('properties.mag') },
        { field: 'depth_km', value: path('properties.depth') },
        {
          field: 'url',
          value: template('https://www.seismicportal.eu/eventdetails.html?unid={properties.unid}'),
        },
      ],
      ...QUAKE_COMMON,
    },
  },
  {
    key: 'feed.gdacs',
    name: 'GDACS: бедствия в регионе',
    description:
      'Глобальная система оповещения о бедствиях (Еврокомиссия и ООН): землетрясения, наводнения, засухи, циклоны, пожары и извержения с уровнем тревоги.',
    schedule: '*/15 * * * *',
    feed: {
      url: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;FL;TC;DR;VO;WF',
      format: 'geojson',
      bbox: [REGION.west, REGION.south, REGION.east, REGION.north],
      geometry: { kind: 'feature' },
      mapping: [
        {
          field: 'code',
          value: template(
            'gdacs:{properties.eventtype}{properties.eventid}-{properties.episodeid}',
          ),
        },
        { field: 'source', value: constant('gdacs') },
        {
          field: 'hazard',
          value: path('properties.eventtype', {
            EQ: 'earthquake',
            FL: 'flood',
            TC: 'cyclone',
            DR: 'drought',
            VO: 'volcano',
            WF: 'fire',
            '*': 'other',
          }),
        },
        { field: 'title', value: path('properties.name') },
        { field: 'occurred_at', value: path('properties.fromdate') },
        {
          field: 'alert_level',
          value: path('properties.alertlevel', { green: 'green', orange: 'orange', red: 'red' }),
        },
        { field: 'url', value: path('properties.url.report') },
      ],
      ...QUAKE_COMMON,
    },
  },
  ...(['Russia_Asia', 'South_Asia'] as const).map((region) => ({
    key: `feed.firms_${region.toLowerCase()}`,
    name: `NASA FIRMS: термические аномалии (${region === 'Russia_Asia' ? 'Россия и Азия' : 'Южная Азия'})`,
    description:
      'Очаги пожаров и термические аномалии по спутнику Suomi NPP (VIIRS) за последние сутки — только внутри страны.',
    schedule: '20 * * * *',
    feed: {
      url: `https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_${region}_24h.csv`,
      format: 'csv' as const,
      bbox: COUNTRY_BBOX,
      withinTerritory: true,
      geometry: { kind: 'latlon' as const, lat: 'latitude', lon: 'longitude' },
      mapping: [
        {
          field: 'code',
          value: template('firms:{latitude}_{longitude}_{acq_date}_{acq_time}_{satellite}'),
        },
        { field: 'source', value: constant('firms') },
        { field: 'hazard', value: constant('fire') },
        { field: 'title', value: template('Термическая аномалия, мощность {frp} МВт') },
        {
          field: 'occurred_at',
          value: { kind: 'date_time' as const, date: 'acq_date', time: 'acq_time' },
        },
        { field: 'frp', value: path('frp') },
        { field: 'url', value: constant('https://firms.modaps.eosdis.nasa.gov/map/') },
      ],
      ...QUAKE_COMMON,
    },
  })),
]

async function ensureFeeds(pack: PackContext, datasets: Ids, writer: string): Promise<string[]> {
  const target = datasets.get('hazard_messages') as string
  // Ленту заводит служебная запись: опрос идёт от имени владельца источника
  const ctx = await buildUserCtxFor(writer)
  if (!ctx) return []
  const created: string[] = []
  for (const spec of FEEDS) {
    if (await findPackObject('source', spec.key)) continue
    const id = await FeedService.create(
      ctx,
      FeedSourceCreateInput.parse({
        name: spec.name,
        description: spec.description,
        spaceId: pack.spaceId,
        feed: spec.feed,
        target: { kind: 'existing', datasetId: target },
        schedule: spec.schedule,
        enabled: true,
      }),
    )
    await db().transaction((tx) => markPackObject(tx, pack.ctx, id, spec.key))
    await syncSourceSchedule(id)
    created.push(spec.key)
  }
  return created
}

// ── Алерты ────────────────────────────────────────────────────────────────────

async function ensureAlerts(
  pack: PackContext,
  metrics: Ids,
  groups: PackStructure['groupIds'],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  const specs = [
    {
      key: 'alert.water',
      metric: 'metric.posts_above_danger',
      name: 'Гидропост выше опасного уровня',
      definition: {
        description: 'Хотя бы один гидропост сегодня выше опасной отметки — дежурной смене.',
        condition: { kind: 'threshold', op: 'gt', value: 0 },
        schedule: { cron: '*/30 * * * *', timezone: config().TZ },
        recipients: [`group:${groups.duty}`],
        channels: { notify: true, inbox: true, email: false },
        cooldownMinutes: 180,
      },
    },
    {
      key: 'alert.incidents_spike',
      metric: 'metric.incidents_today',
      name: 'Необычно много происшествий за сутки',
      definition: {
        description: 'Число происшествий за сутки выбивается из обычного для этого дня недели.',
        condition: { kind: 'anomaly', z: 3, points: 30, seasonality: 'weekly' },
        schedule: { cron: '0 9,15,21 * * *', timezone: config().TZ },
        recipients: [`group:${groups.analysts}`, `group:${groups.hq}`],
        channels: { notify: true, inbox: false, email: false },
        cooldownMinutes: 720,
      },
    },
  ]
  for (const spec of specs) {
    const found = await findPackObject('alert', spec.key)
    if (found) {
      ids.set(spec.key, found)
      continue
    }
    const metricId = metrics.get(spec.metric)
    if (!metricId) continue
    const id = await db().transaction(async (tx) => {
      const created = await AlertService.create(
        tx,
        pack.user,
        AlertCreateInput.parse({
          name: spec.name,
          spaceId: pack.spaceId,
          definition: { metricId, ...spec.definition },
          enabled: true,
        }),
      )
      await markPackObject(tx, pack.ctx, created, spec.key)
      return created
    })
    ids.set(spec.key, id)
  }
  return ids
}

// ── Правила ───────────────────────────────────────────────────────────────────

async function reportsJournal(): Promise<string | null> {
  const [row] = await db()
    .select({ id: journals.id })
    .from(journals)
    .where(eq(journals.name, 'Донесения о ЧС'))
    .limit(1)
  return row?.id ?? null
}

/**
 * Свежесть события ленты: первая загрузка (EMSC отдаёт толчки за месяцы) и догрузка после
 * перерыва связи не должны поднимать смену по давним событиям. Толчок публикуется за минуты,
 * паводок и тревога GDACS — за дни от начала события.
 */
const FRESH_QUAKE = "date_diff(event.payload.values.occurred_at, now(), 'hour') < 24"
const FRESH_HAZARD = "date_diff(event.payload.values.occurred_at, now(), 'day') < 7"

interface PackRule {
  key: string
  /** Включено ли правило после установки; по умолчанию — да. */
  enabled?: boolean
  /** Определение правила во входной форме схемы: значения по умолчанию подставит разбор. */
  definition: Omit<z.input<typeof RuleDefinition>, 'version' | 'runAs' | 'enabled'>
  schedule?: boolean
}

async function packRules(
  pack: PackContext,
  datasets: Ids,
  structure: PackStructure,
  alerts: Ids,
  mapId: string,
): Promise<PackRule[]> {
  const { duty, hq } = structure.groupIds
  const channel = structure.channelId
  const hazard = datasets.get('hazard_messages') as string
  const incidents = datasets.get('incidents') as string
  // Исполнители — руководители подразделений по кодам оргструктуры Комитета: правило
  // работает, как только руководитель назначен; при другой структуре их меняют в конструкторе
  const operations = "unit_head('UO')"
  const shiftHead = "unit_head('UO-DUTY')"
  const chairman = "unit_head('HQ')"
  const journal = await reportsJournal()
  const water = alerts.get('alert.water')
  const where = '{{event.payload.labels.territory}}'
  const list: PackRule[] = [
    {
      key: 'emergency-hazard-duty',
      definition: {
        name: {
          ru: 'Опасное явление в Таджикистане — дежурной смене',
          en: 'Hazard in Tajikistan — duty shift',
        },
        description:
          'Новое сообщение ленты или службы внутри страны: землетрясение от M4 за последние сутки; наводнение, сель, оползень, лавина или оранжевый и красный уровень GDACS за неделю. Старые события первой загрузки ленты не беспокоят смену.',
        trigger: { kind: 'event', type: 'dataset.row_created', filter: { 'object.id': hazard } },
        conditions: {
          and: [
            { expr: "contains(event.payload.territories.territory.path, 'TJ')" },
            {
              or: [
                {
                  and: [{ expr: 'event.payload.values.magnitude >= 4' }, { expr: FRESH_QUAKE }],
                },
                {
                  and: [
                    {
                      or: [
                        { expr: "event.payload.values.alert_level in ('orange', 'red')" },
                        {
                          expr: "event.payload.values.hazard in ('flood', 'mudflow', 'landslide', 'avalanche')",
                        },
                      ],
                    },
                    { expr: FRESH_HAZARD },
                  ],
                },
              ],
            },
          ],
        },
        actions: [
          {
            type: 'notify',
            to: [`group:${duty}`],
            text: `{{event.payload.labels.hazard}}: {{event.payload.values.title}} — ${where}. Решение — в «Сообщениях об опасных явлениях».`,
            channels: ['app', 'push'],
          },
          {
            type: 'send_telegram',
            to: [`group:${duty}`],
            text: `⚠ {{event.payload.labels.hazard}}: {{event.payload.values.title}} — ${where}`,
          },
          {
            type: 'post_message',
            text: `Опасное явление: {{event.payload.labels.hazard}} — {{event.payload.values.title}}, ${where} ({{event.payload.labels.source}}).`,
            conversation: channel,
          },
        ],
        limits: {
          maxRunsPerHour: 60,
          // USGS и EMSC сообщают об одном толчке почти одновременно — одно уведомление
          dedupeKey:
            '{{event.payload.values.hazard}}:{{substr(event.payload.values.occurred_at, 1, 15)}}',
          dedupeWindowMinutes: 60,
        },
      },
    },
    {
      key: 'emergency-strong-quake-hq',
      definition: {
        name: {
          ru: 'Сильное землетрясение в регионе — руководству штаба',
          en: 'Strong earthquake — HQ',
        },
        description:
          'Землетрясение от M5,5 в области мониторинга, в том числе у соседей: такие толчки ощущаются в Таджикистане.',
        trigger: { kind: 'event', type: 'dataset.row_created', filter: { 'object.id': hazard } },
        conditions: {
          and: [
            { expr: "event.payload.values.hazard = 'earthquake'" },
            { expr: 'event.payload.values.magnitude >= 5.5' },
            { expr: FRESH_QUAKE },
          ],
        },
        actions: [
          {
            type: 'notify',
            to: [`group:${hq}`],
            text: 'Сильное землетрясение: {{event.payload.values.title}}. Оцените последствия для районов страны.',
            channels: ['app', 'push'],
          },
          {
            type: 'send_telegram',
            to: [`group:${hq}`],
            text: '⚠ Сильное землетрясение: {{event.payload.values.title}}',
          },
        ],
        limits: {
          maxRunsPerHour: 20,
          dedupeKey: 'quake:{{substr(event.payload.values.occurred_at, 1, 15)}}',
          dedupeWindowMinutes: 60,
        },
      },
    },
    {
      key: 'emergency-incident-deaths',
      definition: {
        name: {
          ru: 'Происшествие с погибшими — руководству штаба',
          en: 'Incident with deaths — HQ',
        },
        description:
          'Новая строка реестра происшествий с погибшими: из суточной сводки, донесения или от дежурного.',
        trigger: { kind: 'event', type: 'dataset.row_created', filter: { 'object.id': incidents } },
        conditions: { expr: 'event.payload.values.deaths >= 1' },
        actions: [
          {
            type: 'notify',
            to: [`group:${hq}`],
            text: `Происшествие с погибшими ({{event.payload.values.deaths}}): ${where}. {{event.payload.values.description}}`,
            channels: ['app', 'push'],
          },
          {
            type: 'post_message',
            text: `Происшествие с погибшими ({{event.payload.values.deaths}}): ${where}. {{event.payload.values.description}}`,
            conversation: channel,
          },
          {
            type: 'create_task' as const,
            title: `Организовать реагирование: происшествие с погибшими, ${where}`,
            description:
              'Уточнить обстановку у регионального управления, силы и средства на месте, потребность в эвакуации и ПВР; доложить руководству штаба.',
            assignee: operations,
            controller: chairman,
            dueWorkingDays: 1,
            priority: 1,
            // Строка реестра — не объект: поручение привязано к карте обстановки штаба
            source: mapId,
          },
        ],
        limits: { maxRunsPerHour: 30, dedupeKey: null, dedupeWindowMinutes: 60 },
      },
    },
    ...(water
      ? [
          {
            key: 'emergency-water-alert',
            definition: {
              name: {
                ru: 'Превышение опасного уровня воды — штабу',
                en: 'Water above danger level — HQ',
              },
              description:
                'Алерт «Гидропост выше опасного уровня»: сообщение в канал штаба и поручение решить вопрос о внеочередном заседании.',
              trigger: {
                kind: 'event' as const,
                type: 'alert.fired',
                filter: { 'object.id': water },
              },
              conditions: null,
              actions: [
                {
                  type: 'post_message' as const,
                  text: 'Превышение опасного уровня воды: {{event.payload.message}}. Ситуационный экран — в пространстве штаба.',
                  conversation: channel,
                },
                {
                  type: 'create_task' as const,
                  title: 'Решить вопрос о внеочередном заседании штаба: превышение уровня воды',
                  description:
                    'Оценить паводковую обстановку (дашборд «Паводки и сели»), готовность ПВР и сил; при необходимости созвать заседание штаба.',
                  assignee: operations,
                  controller: chairman,
                  dueWorkingDays: 1,
                  priority: 1,
                },
              ],
              limits: { maxRunsPerHour: 10, dedupeKey: null, dedupeWindowMinutes: 60 },
            },
          },
        ]
      : []),
    ...(journal
      ? [
          {
            key: 'emergency-report-hq',
            definition: {
              name: {
                ru: 'Донесение о крупной ЧС — руководству штаба',
                en: 'Major emergency report — HQ',
              },
              description:
                'Зарегистрированное донесение с погибшими или масштаба «Региональный» и выше: уведомление руководству и поручение оперативному управлению организовать реагирование.',
              trigger: {
                kind: 'event' as const,
                type: 'document.registered',
                filter: { 'payload.journalId': journal },
              },
              conditions: {
                or: [
                  { expr: 'object.fields.deaths >= 1' },
                  { expr: "object.fields.scale in ('regional', 'national', 'transboundary')" },
                ],
              },
              actions: [
                {
                  type: 'notify' as const,
                  to: [`group:${hq}`],
                  text: 'Донесение {{event.payload.number}}: {{object.title}}. Нужна резолюция руководства штаба.',
                  channels: ['app' as const, 'push' as const],
                },
                {
                  type: 'post_message' as const,
                  text: 'Зарегистрировано донесение {{event.payload.number}}: {{object.title}}.',
                  conversation: channel,
                },
                {
                  type: 'create_task' as const,
                  title: 'Организовать реагирование по донесению {{event.payload.number}}',
                  description:
                    'По регламенту штаба: уточнить обстановку и потребность в силах и средствах, развернуть ПВР при эвакуации, доложить руководству штаба к установленному сроку.',
                  assignee: operations,
                  controller: chairman,
                  dueWorkingDays: 1,
                  priority: 1,
                },
              ],
              limits: { maxRunsPerHour: 30, dedupeKey: null, dedupeWindowMinutes: 60 },
            },
          },
        ]
      : []),
    {
      key: 'emergency-duty-handover',
      schedule: true,
      // Без начальника смены поручение некому ставить: на чистой установке правило
      // включают после назначения руководителей
      enabled: pack.demo,
      definition: {
        name: { ru: 'Приём-передача дежурства', en: 'Duty handover' },
        description:
          'Каждый день в 08:00 — начальнику дежурной смены поручение с перечнем того, что проверить при приёме смены.',
        trigger: {
          kind: 'schedule' as const,
          cron: '0 8 * * *',
          timezone: config().TZ,
          objectId: datasets.get('duty_roster') as string,
        },
        conditions: null,
        actions: [
          {
            type: 'create_task' as const,
            title: 'Приём-передача дежурства {{substr(now, 1, 10)}}',
            description:
              'Проверить: обстановку за сутки на ситуационном экране; нерассмотренные сообщения об опасных явлениях; несданные суточные сводки; поручения штаба со сроком сегодня; связь, оповещение и резервное рабочее место.',
            assignee: shiftHead,
            controller: operations,
            dueWorkingDays: 1,
            priority: 2,
          },
        ],
        limits: { maxRunsPerHour: 2, dedupeKey: null, dedupeWindowMinutes: 60 },
      },
    },
  ]
  return list as PackRule[]
}

async function ensureRules(
  pack: PackContext,
  datasets: Ids,
  structure: PackStructure,
  alerts: Ids,
  writer: string,
  mapId: string,
): Promise<string[]> {
  const created: string[] = []
  for (const rule of await packRules(pack, datasets, structure, alerts, mapId)) {
    const [existing] = await db()
      .select({ id: rules.id })
      .from(rules)
      .where(eq(rules.key, rule.key))
      .limit(1)
    if (existing) continue
    const id = await db().transaction((tx) =>
      RuleService.create(
        tx,
        pack.user,
        RuleCreateInput.parse({
          spaceId: pack.spaceId,
          key: rule.key,
          definition: {
            ...rule.definition,
            version: 1,
            runAs: writer,
            enabled: rule.enabled ?? true,
          },
        }),
      ),
    )
    if (rule.schedule) await syncRuleSchedule(id)
    created.push(rule.key)
  }
  return created
}

export async function ensureAutomation(
  pack: PackContext,
  datasets: Ids,
  metrics: Ids,
  structure: PackStructure,
  mapId: string,
): Promise<{ writer: string }> {
  const writer = await ensureServiceAccount(pack, datasets)
  const forms = await ensureForms(pack, datasets, writer, structure.groupIds)
  const feeds = await ensureFeeds(pack, datasets, writer)
  const alerts = await ensureAlerts(pack, metrics, structure.groupIds)
  const created = await ensureRules(pack, datasets, structure, alerts, writer, mapId)
  pack.log('автоматизация пакета ЧС готова', { forms, feeds, alerts: alerts.size, rules: created })
  return { writer }
}
