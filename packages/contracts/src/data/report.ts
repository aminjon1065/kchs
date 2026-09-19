import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Locale, Timestamp, Uuid } from '../common/primitives.js'
import { RichBody } from '../discussions/message.js'
import { MapCamera } from '../gis/map.js'
import { ChartType } from './chart.js'
import { ExplorePlan } from './explore.js'
import {
  EMPTY_EXPLORE_PLAN,
  NotebookBindings,
  type NotebookCell,
  NotebookCellId,
  NotebookParams,
  type NotebookValueKind,
} from './notebook.js'
import { SQL_MAX_LENGTH } from './sql.js'

/**
 * Отчёт (06-analytics-engine.md §12, P2-E05 S03–S05, ADR-0078) — объект реестра
 * `report`: шаблон — документ из блоков (текст, запрос, график, показатели,
 * карта, разрыв страницы) с параметрами (период, территория — как у тетради) и
 * настройками печати. Шаблон правится совместно — документ Yjs (ADR-0070), как
 * тетрадь; здесь — его JSON-снимок, запуски рендера, расписание и рассылка.
 */

export const REPORT_BLOCK_KINDS = [
  'text',
  'query',
  'chart',
  'metrics',
  'map',
  'page_break',
] as const
export const ReportBlockKind = z.enum(REPORT_BLOCK_KINDS)
export type ReportBlockKind = z.infer<typeof ReportBlockKind>

/** Блоков в отчёте не больше — документ остаётся лёгким для совместной правки. */
export const REPORT_MAX_BLOCKS = 200
/** Показателей в одном блоке-сетке. */
export const REPORT_MAX_METRICS = 12
/** Строк таблицы в отчёте: больше — выгрузка датасета, а не отчёт. */
export const REPORT_MAX_TABLE_ROWS = 1000

export const ReportBlockId = NotebookCellId

/** Высота графика и карты на странице: малая, средняя, крупная. */
export const REPORT_FIGURE_SIZES = ['small', 'medium', 'large'] as const
export const ReportFigureSize = z.enum(REPORT_FIGURE_SIZES)
export type ReportFigureSize = z.infer<typeof ReportFigureSize>

/** Высота фигуры, px на странице печати (A4 книжная — около 700 px ширины). */
export const REPORT_FIGURE_HEIGHT: Record<ReportFigureSize, number> = {
  small: 220,
  medium: 320,
  large: 460,
}

const base = {
  id: ReportBlockId,
  /** Подпись блока в отчёте и в оглавлении редактора; у текста — его заголовки. */
  title: z.string().max(200).nullable().default(null),
}

export const ReportTextBlock = z.object({
  ...base,
  kind: z.literal('text'),
  body: RichBody.default({ type: 'doc', content: [] }),
})

/**
 * Запрос (как ячейка тетради): визуальный конструктор «Исследования» или SQL
 * (способность `data.sql` у того, под чьими правами строится отчёт), результат —
 * таблицей или графиком. Таблица — «с ограничением строк».
 */
export const ReportQueryBlock = z.object({
  ...base,
  kind: z.literal('query'),
  mode: z.enum(['visual', 'sql']).default('visual'),
  sql: z.string().max(SQL_MAX_LENGTH).default(''),
  datasetId: Uuid.nullable().default(null),
  plan: ExplorePlan.default(EMPTY_EXPLORE_PLAN),
  view: z.enum(['table', 'chart']).default('table'),
  /** null — тип графика подбирается по результату. */
  chartType: ChartType.nullable().default(null),
  bindings: NotebookBindings.default({}),
  size: ReportFigureSize.default('medium'),
  maxRows: z.number().int().min(1).max(REPORT_MAX_TABLE_ROWS).default(100),
})

/** Сохранённый график: графиком или его таблицей данных («график-таблица»). */
export const ReportChartBlock = z.object({
  ...base,
  kind: z.literal('chart'),
  chartId: Uuid.nullable().default(null),
  bindings: NotebookBindings.default({}),
  view: z.enum(['chart', 'table']).default('chart'),
  size: ReportFigureSize.default('medium'),
})

/** Сетка показателей: значения со сравнением, период — параметр отчёта. */
export const ReportMetricsBlock = z.object({
  ...base,
  kind: z.literal('metrics'),
  metricIds: z.array(Uuid).max(REPORT_MAX_METRICS).default([]),
  bindings: NotebookBindings.default({}),
})

/**
 * Карта: сохранённая карта (подложка, слои, вид) или один слой на подложке по
 * умолчанию. Вид `camera` — свой у блока; null — вид карты или охват слоя.
 */
export const ReportMapBlock = z.object({
  ...base,
  kind: z.literal('map'),
  source: z.enum(['map', 'layer']).default('map'),
  mapId: Uuid.nullable().default(null),
  layerId: Uuid.nullable().default(null),
  camera: MapCamera.nullable().default(null),
  size: ReportFigureSize.default('large'),
  legend: z.boolean().default(true),
})

export const ReportPageBreakBlock = z.object({ ...base, kind: z.literal('page_break') })

export const ReportBlock = z.discriminatedUnion('kind', [
  ReportTextBlock,
  ReportQueryBlock,
  ReportChartBlock,
  ReportMetricsBlock,
  ReportMapBlock,
  ReportPageBreakBlock,
])
export type ReportBlock = z.infer<typeof ReportBlock>
export type ReportBlockInput = z.input<typeof ReportBlock>

/** Параметры отчёта — те же, что у тетради: период и территория (ADR-0071). */
export const ReportParams = NotebookParams
export type ReportParams = NotebookParams

export const REPORT_FORMATS = ['pdf', 'docx'] as const
export const ReportFormat = z.enum(REPORT_FORMATS)
export type ReportFormat = z.infer<typeof ReportFormat>

export const REPORT_CONTENT_TYPES: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** Печать: A4, ориентация, колонтитулы (пусто — название отчёта), титульный лист, форматы. */
export const ReportSettings = z.object({
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  header: z.string().max(200).default(''),
  footer: z.string().max(200).default(''),
  titlePage: z.boolean().default(false),
  /** Форматы запуска по умолчанию («Сформировать»). */
  formats: z.array(ReportFormat).min(1).max(REPORT_FORMATS.length).default(['pdf']),
})
export type ReportSettings = z.infer<typeof ReportSettings>

export const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  orientation: 'portrait',
  header: '',
  footer: '',
  titlePage: false,
  formats: ['pdf'],
}

export const ReportRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  blocks: z.array(ReportBlock),
  params: ReportParams,
  settings: ReportSettings,
  /** Есть включённое расписание рассылки. */
  scheduled: z.boolean(),
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type ReportRecord = z.infer<typeof ReportRecord>

export const ReportCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  blocks: z.array(ReportBlock).max(REPORT_MAX_BLOCKS).default([]),
  params: ReportParams.default({ period: null, territory: null }),
  settings: ReportSettings.default(DEFAULT_REPORT_SETTINGS),
})
export type ReportCreateInput = z.infer<typeof ReportCreateInput>

/** «Экспорт в отчёт» из тетради: ячейки → блоки, параметры тетради → параметры отчёта. */
export const ReportFromNotebookInput = z.object({
  notebookId: Uuid,
  name: z.string().trim().min(1).max(200).optional(),
  /** Куда положить отчёт; по умолчанию — рядом с тетрадью. */
  spaceId: Uuid.optional(),
  parentId: Uuid.nullable().optional(),
})
export type ReportFromNotebookInput = z.infer<typeof ReportFromNotebookInput>

/**
 * Ячейки тетради → блоки отчёта (P2-E05 S03): текст, запрос и ИИ-ответ (его план)
 * — как есть, график — график, показатель — сетка из одного показателя, карта —
 * карта. Одна функция для сервера и клиента.
 */
export function notebookCellsToBlocks(cells: readonly NotebookCell[]): ReportBlock[] {
  const blocks: ReportBlock[] = []
  for (const cell of cells) {
    const title = cell.title
    switch (cell.kind) {
      case 'text':
        blocks.push(ReportBlock.parse({ id: cell.id, kind: 'text', title, body: cell.body }))
        break
      case 'query':
      case 'ai': {
        const sql = cell.kind === 'query' && cell.mode === 'sql'
        blocks.push(
          ReportBlock.parse({
            id: cell.id,
            kind: 'query',
            title: title ?? (cell.kind === 'ai' ? (cell.answer?.title ?? null) : null),
            mode: sql ? 'sql' : 'visual',
            sql: cell.kind === 'query' ? cell.sql : '',
            datasetId: cell.datasetId,
            plan: cell.plan,
            view: sql ? 'table' : cell.view,
            chartType: cell.chartType,
            bindings: cell.bindings,
          }),
        )
        break
      }
      case 'chart':
        blocks.push(
          ReportBlock.parse({
            id: cell.id,
            kind: 'chart',
            title,
            chartId: cell.chartId,
            bindings: cell.bindings,
          }),
        )
        break
      case 'metric':
        blocks.push(
          ReportBlock.parse({
            id: cell.id,
            kind: 'metrics',
            title,
            metricIds: cell.metricId ? [cell.metricId] : [],
            bindings: cell.bindings,
          }),
        )
        break
      case 'map':
        blocks.push(
          ReportBlock.parse({ id: cell.id, kind: 'map', title, source: 'map', mapId: cell.mapId }),
        )
        break
    }
  }
  return blocks.slice(0, REPORT_MAX_BLOCKS)
}

/** Объекты, на которые ссылаются блоки: зависимости отчёта («Используется в»). */
export function reportBlockReferences(blocks: readonly ReportBlock[]): string[] {
  const ids = new Set<string>()
  for (const block of blocks) {
    if (block.kind === 'query' && block.datasetId) ids.add(block.datasetId)
    if (block.kind === 'chart' && block.chartId) ids.add(block.chartId)
    if (block.kind === 'metrics') for (const id of block.metricIds) ids.add(id)
    if (block.kind === 'map' && block.source === 'map' && block.mapId) ids.add(block.mapId)
    if (block.kind === 'map' && block.source === 'layer' && block.layerId) ids.add(block.layerId)
  }
  return [...ids]
}

// ─── Документ Yjs ────────────────────────────────────────────────────────────

/**
 * Раскладка документа Yjs отчёта — как у тетради (ADR-0071): `Y.Map` блоков по
 * идентификатору, `order` — `Y.Array` идентификаторов по порядку, `params` и
 * `settings` — `Y.Map` значений. Имена корневых типов и ключи запроса и графика
 * совпадают с тетрадью: клиент правит оба документа одними функциями и рисует
 * блоки-запросы теми же компонентами, что ячейки.
 */
export const REPORT_DOC = {
  blocks: 'cells',
  order: 'order',
  params: 'params',
  settings: 'settings',
} as const

const COMMON_LAYOUT = { id: 'json', kind: 'json', title: 'json' } as const

export const REPORT_BLOCK_LAYOUT = {
  text: { ...COMMON_LAYOUT, body: 'rich' },
  query: {
    ...COMMON_LAYOUT,
    mode: 'json',
    sql: 'text',
    datasetId: 'json',
    plan: 'json',
    view: 'json',
    chartType: 'json',
    bindings: 'json',
    size: 'json',
    maxRows: 'json',
  },
  chart: { ...COMMON_LAYOUT, chartId: 'json', bindings: 'json', view: 'json', size: 'json' },
  metrics: { ...COMMON_LAYOUT, metricIds: 'json', bindings: 'json' },
  map: {
    ...COMMON_LAYOUT,
    source: 'json',
    mapId: 'json',
    layerId: 'json',
    camera: 'json',
    size: 'json',
    legend: 'json',
  },
  page_break: { ...COMMON_LAYOUT },
} as const satisfies Record<ReportBlockKind, Record<string, NotebookValueKind>>

// ─── Запуски ─────────────────────────────────────────────────────────────────

export const REPORT_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const
export const ReportRunStatus = z.enum(REPORT_RUN_STATUSES)
export type ReportRunStatus = z.infer<typeof ReportRunStatus>

export const ReportRunTrigger = z.enum(['manual', 'schedule'])
export type ReportRunTrigger = z.infer<typeof ReportRunTrigger>

/** Каналы рассылки по расписанию: Входящие, почта, Telegram (бот присылает файл). */
export const REPORT_DELIVERY_CHANNELS = ['inbox', 'email', 'telegram'] as const
export const ReportDeliveryChannel = z.enum(REPORT_DELIVERY_CHANNELS)
export type ReportDeliveryChannel = z.infer<typeof ReportDeliveryChannel>

/** Итог доставки по каналу: отправлено, канал недоступен получателю, сбой. */
export const ReportDeliveryStatus = z.enum(['sent', 'unavailable', 'failed'])
export type ReportDeliveryStatus = z.infer<typeof ReportDeliveryStatus>

export const ReportRunFile = z.object({
  format: ReportFormat,
  fileName: z.string(),
  size: z.number().int().nonnegative(),
})
export type ReportRunFile = z.infer<typeof ReportRunFile>

export const ReportRunRecord = z.object({
  id: Uuid,
  reportId: Uuid,
  trigger: ReportRunTrigger,
  /** Под чьими правами построен отчёт — ему же он доставляется. */
  runAs: UserRef,
  status: ReportRunStatus,
  params: ReportParams,
  formats: z.array(ReportFormat),
  files: z.array(ReportRunFile),
  pages: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  delivery: z.partialRecord(ReportDeliveryChannel, ReportDeliveryStatus),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  /** Файл скачивает только тот, под чьими правами он построен (ADR-0078). */
  canDownload: z.boolean(),
})
export type ReportRunRecord = z.infer<typeof ReportRunRecord>

export const ReportRunList = z.object({ items: z.array(ReportRunRecord) })
export type ReportRunList = z.infer<typeof ReportRunList>

/** «Сформировать»: форматы и параметры запуска; не заданы — из отчёта. */
export const ReportRunInput = z.object({
  formats: z.array(ReportFormat).min(1).max(REPORT_FORMATS.length).optional(),
  params: ReportParams.optional(),
})
export type ReportRunInput = z.infer<typeof ReportRunInput>

export const ReportRunDownload = z.object({ url: z.string() })

// ─── Расписание и рассылка ───────────────────────────────────────────────────

export const REPORT_SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'cron'] as const
export const ReportScheduleFrequency = z.enum(REPORT_SCHEDULE_FREQUENCIES)
export type ReportScheduleFrequency = z.infer<typeof ReportScheduleFrequency>

/** Получателей одного расписания: каждый получает свой рендер под своими правами. */
export const REPORT_MAX_RECIPIENTS = 100

export const ReportScheduleInput = z.object({
  enabled: z.boolean().default(true),
  frequency: ReportScheduleFrequency,
  /** Время запуска для daily/weekly/monthly — ЧЧ:ММ в поясе расписания. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('08:00'),
  /** Дни недели для weekly: 1 — понедельник … 7 — воскресенье. */
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1]),
  /** День месяца для monthly (до 28-го — есть в каждом месяце). */
  monthDay: z.number().int().min(1).max(28).default(1),
  /** Выражение cron из пяти полей для frequency = cron. */
  cron: z.string().trim().max(100).nullable().default(null),
  /** Часовой пояс IANA, например Asia/Dushanbe. */
  timezone: z.string().min(1).max(64),
  recipients: z.array(Uuid).min(1).max(REPORT_MAX_RECIPIENTS),
  channels: z.array(ReportDeliveryChannel).min(1).max(REPORT_DELIVERY_CHANNELS.length),
  formats: z.array(ReportFormat).min(1).max(REPORT_FORMATS.length).default(['pdf']),
  /** Параметры рассылки; null — параметры отчёта. Период — обычно относительный. */
  params: ReportParams.nullable().default(null),
})
export type ReportScheduleInput = z.infer<typeof ReportScheduleInput>

export const ReportSchedule = ReportScheduleInput.extend({
  /** Выражение cron, по которому работает планировщик. */
  pattern: z.string(),
  nextRunAt: Timestamp.nullable(),
  recipientRefs: z.array(UserRef),
  /** Получатели, которые сейчас не видят отчёт: им рассылка не придёт. */
  recipientsWithoutAccess: z.array(Uuid),
  updatedBy: UserRef.nullable(),
  updatedAt: Timestamp,
})
export type ReportSchedule = z.infer<typeof ReportSchedule>

/** Расписание → выражение cron из пяти полей (минута, час, день, месяц, день недели). */
export function reportCronPattern(
  schedule: Pick<ReportScheduleInput, 'frequency' | 'time' | 'weekdays' | 'monthDay' | 'cron'>,
): string {
  if (schedule.frequency === 'cron') return (schedule.cron ?? '').trim().replace(/\s+/g, ' ')
  const [hour = '8', minute = '0'] = schedule.time.split(':')
  const time = `${Number(minute)} ${Number(hour)}`
  if (schedule.frequency === 'daily') return `${time} * * *`
  if (schedule.frequency === 'monthly') return `${time} ${schedule.monthDay} * *`
  // В cron воскресенье — 0, у нас — 7
  const days = [...new Set(schedule.weekdays.map((day) => day % 7))].sort((a, b) => a - b)
  return `${time} * * ${days.join(',')}`
}

// ─── Печать (web ↔ движок) ──────────────────────────────────────────────────

/**
 * Страница печати `/print/report/{runId}`: всё, что нужно, чтобы нарисовать
 * отчёт с правами того, под кем он строится (ADR-0078).
 */
export const ReportPrintPayload = z.object({
  report: z.object({
    id: Uuid,
    name: z.string(),
    blocks: z.array(ReportBlock),
    settings: ReportSettings,
  }),
  params: ReportParams,
  /** null — предпросмотр текущего шаблона без запуска. */
  run: z.object({ id: Uuid, trigger: ReportRunTrigger, createdAt: Timestamp }).nullable(),
  user: z.object({
    id: Uuid,
    displayName: z.string(),
    locale: Locale,
    timezone: z.string(),
    canSql: z.boolean(),
  }),
  generatedAt: Timestamp,
})
export type ReportPrintPayload = z.infer<typeof ReportPrintPayload>

/** Модель документа, которую страница печати отдаёт движку (DOCX): значения уже посчитаны. */
export const PRINT_MODEL_VERSION = 1

export const ReportPrintBlock = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('text'), body: RichBody }),
  /** График или карта — картинкой: движок снимает элемент `[data-print-figure=id]`. */
  z.object({
    id: z.string(),
    kind: z.literal('figure'),
    title: z.string().nullable(),
    figure: z.enum(['chart', 'map']),
    note: z.string().nullable(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('table'),
    title: z.string().nullable(),
    columns: z.array(z.object({ label: z.string(), numeric: z.boolean() })),
    rows: z.array(z.array(z.string())),
    total: z.number().int(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('metrics'),
    title: z.string().nullable(),
    items: z.array(z.object({ label: z.string(), value: z.string(), note: z.string() })),
  }),
  /** Нет доступа к источнику, ошибка, пусто — текстом на месте блока. */
  z.object({
    id: z.string(),
    kind: z.literal('notice'),
    title: z.string().nullable(),
    text: z.string(),
  }),
  z.object({ id: z.string(), kind: z.literal('page_break') }),
])
export type ReportPrintBlock = z.infer<typeof ReportPrintBlock>

export const ReportPrintModel = z.object({
  version: z.literal(PRINT_MODEL_VERSION),
  title: z.string(),
  /** Параметры и дата формирования одной строкой — под заголовком. */
  subtitle: z.string(),
  settings: ReportSettings,
  /** Подписи колонтитулов на языке получателя. */
  labels: z.object({ page: z.string(), of: z.string() }),
  blocks: z.array(ReportPrintBlock),
})
export type ReportPrintModel = z.infer<typeof ReportPrintModel>

/** Файл запуска, который движок кладёт в бакет экспортов. */
export const ReportRenderFile = z.object({
  format: ReportFormat,
  key: z.string().min(1).max(1024),
  fileName: z.string(),
  contentType: z.string(),
})

/**
 * Движок начинает рендер (внутренний маршрут, сервисный токен): служебный токен
 * страницы печати и всё для PDF/DOCX; `skip` — запуск не нужен (получатель
 * потерял доступ, запуск уже закончен).
 */
export const ReportRenderStart = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('render'),
    token: z.string(),
    printPath: z.string(),
    locale: Locale,
    timezone: z.string(),
    title: z.string(),
    orientation: z.enum(['portrait', 'landscape']),
    /** Колонтитулы PDF и DOCX: пустой верхний — название отчёта. */
    header: z.string(),
    footer: z.string(),
    labels: z.object({ page: z.string(), of: z.string() }),
    bucket: z.string(),
    files: z.array(ReportRenderFile).min(1),
  }),
  z.object({ status: z.literal('skip'), reason: z.string() }),
])
export type ReportRenderStart = z.infer<typeof ReportRenderStart>

/** Движок сообщает итог рендера: файлы в бакете, страницы, длительность. */
export const ReportRenderResult = z.object({
  files: z
    .array(
      z.object({
        format: ReportFormat,
        key: z.string().min(1).max(1024),
        size: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(REPORT_FORMATS.length),
  pages: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** Этапы рендера, мс: загрузка, готовность страницы, PDF, DOCX — в журнал. */
  timings: z.record(z.string(), z.number()).default({}),
})
export type ReportRenderResult = z.infer<typeof ReportRenderResult>

/**
 * Договорённости страницы печати и движка: cookie служебного токена, признаки
 * готовности и снимков. Движок получает их из `report_render.json`.
 */
export const REPORT_PRINT = {
  cookie: 'kchs_print',
  /** `<html data-print-state="ready|error">` — страница дорисована. */
  stateAttribute: 'data-print-state',
  /** Элемент графика или карты для картинки DOCX: `[data-print-figure="<id блока>"]`. */
  figureAttribute: 'data-print-figure',
  /** Модель документа — `window.kchsPrint`. */
  modelGlobal: 'kchsPrint',
  /** Токен печати живёт не дольше, мс: рендер укладывается в бюджет 60 с с запасом. */
  grantTtlMs: 15 * 60_000,
  /** Страница должна дорисоваться за это время, иначе — сбой рендера. */
  readyTimeoutMs: 120_000,
} as const
