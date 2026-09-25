import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { RichBody } from '../discussions/message.js'
import { DiffSegment } from '../documents/compare.js'

/**
 * Страница базы знаний (13-search-knowledge-ai.md §2, 03-screens.md §18) —
 * объект реестра `page`: блоки по порядку в дереве пространства. Тело правится
 * совместно — документ Yjs (ADR-0070, ADR-0071, ADR-0095); здесь — его
 * JSON-снимок для поиска, версий, печати и создания страницы через API.
 */

/**
 * Виды блоков. `text` — текст Tiptap; `table`, `image`, `file` — содержимое
 * страницы; `chart`, `map`, `dataset`, `metric`, `tasks` — встроенные объекты
 * реестра (рисует их клиент теми же представлениями, что и в тетради).
 */
export const PAGE_BLOCK_KINDS = [
  'text',
  'table',
  'image',
  'file',
  'chart',
  'map',
  'dataset',
  'metric',
  'tasks',
] as const
export const PageBlockKind = z.enum(PAGE_BLOCK_KINDS)
export type PageBlockKind = z.infer<typeof PageBlockKind>

/** Блоков на странице не больше — документ остаётся лёгким для совместной правки. */
export const PAGE_MAX_BLOCKS = 300

/** Строк и столбцов в блоке-таблице не больше: таблица правится целиком. */
export const PAGE_TABLE_MAX_ROWS = 200
export const PAGE_TABLE_MAX_COLUMNS = 12

export const PageBlockId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)

const base = {
  id: PageBlockId,
  /** Подпись блока в оглавлении; у текста оглавление — его заголовки. */
  title: z.string().max(200).nullable().default(null),
}

export const PageTextBlock = z.object({
  ...base,
  kind: z.literal('text'),
  body: RichBody.default({ type: 'doc', content: [] }),
})

export const PageTableBlock = z.object({
  ...base,
  kind: z.literal('table'),
  columns: z.array(z.string().max(200)).max(PAGE_TABLE_MAX_COLUMNS).default([]),
  rows: z
    .array(z.array(z.string().max(2000)).max(PAGE_TABLE_MAX_COLUMNS))
    .max(PAGE_TABLE_MAX_ROWS)
    .default([]),
})

/** Изображение — файл реестра (права от него же); подпись под картинкой. */
export const PageImageBlock = z.object({
  ...base,
  kind: z.literal('image'),
  fileId: Uuid.nullable().default(null),
  caption: z.string().max(500).default(''),
  /** Доля ширины колонки: 0,25…1. */
  width: z.number().min(0.25).max(1).default(1),
})

export const PageFileBlock = z.object({
  ...base,
  kind: z.literal('file'),
  fileId: Uuid.nullable().default(null),
})

export const PageChartBlock = z.object({
  ...base,
  kind: z.literal('chart'),
  chartId: Uuid.nullable().default(null),
})

/** Карта или один слой — как ячейка карты в тетради (ADR-0074). */
export const PageMapBlock = z.object({
  ...base,
  kind: z.literal('map'),
  mapId: Uuid.nullable().default(null),
  layerId: Uuid.nullable().default(null),
})

/** Таблица датасета: первые строки датасета с его схемой. */
export const PageDatasetBlock = z.object({
  ...base,
  kind: z.literal('dataset'),
  datasetId: Uuid.nullable().default(null),
  limit: z.number().int().min(1).max(200).default(20),
})

export const PageMetricBlock = z.object({
  ...base,
  kind: z.literal('metric'),
  metricId: Uuid.nullable().default(null),
})

/** Список задач — открытые задачи проекта (10-tasks-projects.md §4). */
export const PageTasksBlock = z.object({
  ...base,
  kind: z.literal('tasks'),
  projectId: Uuid.nullable().default(null),
})

export const PageBlock = z.discriminatedUnion('kind', [
  PageTextBlock,
  PageTableBlock,
  PageImageBlock,
  PageFileBlock,
  PageChartBlock,
  PageMapBlock,
  PageDatasetBlock,
  PageMetricBlock,
  PageTasksBlock,
])
export type PageBlock = z.infer<typeof PageBlock>
export type PageBlockInput = z.input<typeof PageBlock>

/**
 * Состояние страницы: `draft` — черновик, `published` — опубликована,
 * `review` — на пересмотре (подошёл срок или владелец вернул её в работу).
 */
export const PAGE_STATUSES = ['draft', 'published', 'review'] as const
export const PageStatus = z.enum(PAGE_STATUSES)
export type PageStatus = z.infer<typeof PageStatus>

/** Шаблоны страниц: набор блоков-заготовок (13-search-knowledge-ai.md §2). */
export const PAGE_TEMPLATES = ['blank', 'instruction', 'regulation', 'reference', 'faq'] as const
export const PageTemplate = z.enum(PAGE_TEMPLATES)
export type PageTemplate = z.infer<typeof PageTemplate>

/**
 * Шаблоны с обязательным пересмотром (05-risks N35): регламенту и инструкции срок
 * пересмотра ставится сам — год от публикации, если при публикации не задан другой.
 */
export const REVIEWED_PAGE_TEMPLATES: readonly PageTemplate[] = ['regulation', 'instruction']

/** Пункт оглавления: заголовки текста и подписи блоков с якорем на блок. */
export const PageOutlineItem = z.object({
  blockId: PageBlockId,
  /** Порядковый номер заголовка внутри текстового блока (0 — сам блок). */
  index: z.number().int().nonnegative(),
  level: z.number().int().min(1).max(4),
  text: z.string(),
})
export type PageOutlineItem = z.infer<typeof PageOutlineItem>

export const PageRecord = z.object({
  id: Uuid,
  title: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  status: PageStatus,
  template: PageTemplate,
  blocks: z.array(PageBlock),
  outline: z.array(PageOutlineItem),
  /** Владелец страницы — он отвечает за пересмотр (по умолчанию автор). */
  owner: UserRef.nullable(),
  /** Срок пересмотра; наступил — страница уходит в `review`, владельцу — дело. */
  reviewAt: DateOnly.nullable(),
  /**
   * Срок пересмотра прошёл больше месяца назад (N35): читатель видит предупреждение, что
   * текст мог устареть.
   */
  reviewStale: z.boolean(),
  publishedAt: Timestamp.nullable(),
  publishedBy: UserRef.nullable(),
  /** Номер последней версии; 0 — версий ещё нет. */
  versionNumber: z.number().int().nonnegative(),
  acknowledgmentRequested: z.boolean(),
  can: z.object({
    edit: z.boolean(),
    publish: z.boolean(),
    manage: z.boolean(),
    requestAcknowledgment: z.boolean(),
  }),
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type PageRecord = z.infer<typeof PageRecord>

export const PageCreateInput = z.object({
  title: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  /** Родительская страница; без неё — корень дерева пространства. */
  parentId: Uuid.nullable().optional(),
  template: PageTemplate.default('blank'),
  /** Блоки вместо заготовки шаблона (копирование страницы, импорт). */
  blocks: z.array(PageBlock).max(PAGE_MAX_BLOCKS).optional(),
})
export type PageCreateInput = z.infer<typeof PageCreateInput>

/** Блоки, добавленные сервером (шаблон, вставка объекта): сразу видны всем. */
export const PageBlocksInput = z.object({
  blocks: z.array(PageBlock).min(1).max(20),
  /** Позиция вставки; по умолчанию — в конец. */
  index: z.number().int().min(0).optional(),
})
export type PageBlocksInput = z.infer<typeof PageBlocksInput>

/** Владелец, срок пересмотра и возврат в работу; публикация — своим действием. */
export const PageUpdateInput = z.object({
  ownerId: Uuid.nullable().optional(),
  reviewAt: DateOnly.nullable().optional(),
  status: z.enum(['draft', 'review']).optional(),
})
export type PageUpdateInput = z.infer<typeof PageUpdateInput>

export const PagePublishInput = z.object({
  note: z.string().max(500).nullable().default(null),
  /**
   * Срок следующего пересмотра; не задан — остаётся прежним. У регламента и инструкции
   * без срока (не задан или пуст) ставится год от публикации (N35).
   */
  reviewAt: DateOnly.nullable().optional(),
})
export type PagePublishInput = z.infer<typeof PagePublishInput>

/** Запрос ознакомления со страницей — механизмом ядра (ADR-0084). */
export const PageAcknowledgeInput = z.object({
  userIds: z.array(Uuid).max(500).default([]),
  unitIds: z.array(Uuid).max(50).default([]),
  dueAt: DateOnly.nullable().default(null),
  requireSecondFactor: z.boolean().default(false),
  note: z.string().max(500).nullable().default(null),
})
export type PageAcknowledgeInput = z.infer<typeof PageAcknowledgeInput>

// ─── Версии ──────────────────────────────────────────────────────────────────

/** Откуда версия: публикация, кнопка «Сохранить версию», откат. */
export const PAGE_VERSION_REASONS = ['publish', 'manual', 'restore'] as const
export const PageVersionReason = z.enum(PAGE_VERSION_REASONS)
export type PageVersionReason = z.infer<typeof PageVersionReason>

export const PageVersionRecord = z.object({
  id: Uuid,
  number: z.number().int().positive(),
  title: z.string(),
  reason: PageVersionReason,
  note: z.string().nullable(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
})
export type PageVersionRecord = z.infer<typeof PageVersionRecord>

export const PageVersionDetail = PageVersionRecord.extend({
  blocks: z.array(PageBlock),
})
export type PageVersionDetail = z.infer<typeof PageVersionDetail>

export const PageVersionInput = z.object({ note: z.string().max(500).nullable().default(null) })
export type PageVersionInput = z.infer<typeof PageVersionInput>

export const PageVersionCompareQuery = z.object({
  /** Версия «слева»; не задана — предыдущая для `to`. */
  from: Uuid.optional(),
  /** Версия «справа»; не задана — текущий текст страницы. */
  to: Uuid.optional(),
})
export type PageVersionCompareQuery = z.infer<typeof PageVersionCompareQuery>

const PageVersionSide = z.object({
  id: Uuid.nullable(),
  /** 0 — текущий текст страницы (ещё не версия). */
  number: z.number().int().nonnegative(),
  title: z.string(),
  createdAt: Timestamp.nullable(),
})

export const PageVersionCompareResult = z.object({
  from: PageVersionSide,
  to: PageVersionSide,
  segments: z.array(DiffSegment),
  stats: z.object({
    inserted: z.number().int(),
    deleted: z.number().int(),
    unchanged: z.number().int(),
  }),
  /** Текст длиннее предела сравнения — сравнено начало. */
  truncated: z.boolean(),
})
export type PageVersionCompareResult = z.infer<typeof PageVersionCompareResult>

// ─── Дерево и поиск ──────────────────────────────────────────────────────────

export const PageTreeNode = z.object({
  id: Uuid,
  title: z.string(),
  parentId: Uuid.nullable(),
  status: PageStatus,
  hasChildren: z.boolean(),
  updatedAt: Timestamp,
})
export type PageTreeNode = z.infer<typeof PageTreeNode>

export const PageTreeQuery = z.object({
  spaceId: Uuid,
  /** Поиск по названию: дерево сворачивается в плоский список найденного. */
  q: z.string().max(200).optional(),
})
export type PageTreeQuery = z.infer<typeof PageTreeQuery>

export const PageTreeResult = z.object({ items: z.array(PageTreeNode) })
export type PageTreeResult = z.infer<typeof PageTreeResult>

/** Найденный кусок страницы: заголовок, фрагмент с подсветкой, якорь на блок. */
export const PageChunkHit = z.object({
  pageId: Uuid,
  blockId: PageBlockId.nullable(),
  title: z.string(),
  spaceId: Uuid.nullable(),
  heading: z.string().nullable(),
  snippet: z.string(),
  /** `text` — совпадение слов (Meilisearch), `semantic` — по смыслу (ADR-0095). */
  source: z.enum(['text', 'semantic']),
  score: z.number().nullable(),
})
export type PageChunkHit = z.infer<typeof PageChunkHit>

export const PageSearchQuery = z.object({
  q: z.string().min(1).max(500),
  spaceId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Искать по смыслу, если источник подключён; без него — только слова. */
  semantic: z.coerce.boolean().default(true),
})
export type PageSearchQuery = z.infer<typeof PageSearchQuery>

export const PageSearchResult = z.object({
  items: z.array(PageChunkHit),
  /** Семантика участвовала в выдаче (источник подключён и ответил). */
  semantic: z.boolean(),
})
export type PageSearchResult = z.infer<typeof PageSearchResult>

// ─── Документ Yjs ────────────────────────────────────────────────────────────

/**
 * Раскладка документа Yjs страницы (ADR-0071, ADR-0095), как у тетради:
 * `blocks` — `Y.Map` блоков по идентификатору, `order` — `Y.Array`
 * идентификаторов по порядку (перенос блока не трогает его содержимое).
 * Блок — `Y.Map` с ключами из раскладки его вида: `rich` — `Y.XmlFragment`
 * (текст Tiptap), `text` — `Y.Text`, `json` — значение целиком.
 */
export const PAGE_DOC = { blocks: 'blocks', order: 'order' } as const

export type PageValueKind = 'rich' | 'text' | 'json'

const COMMON_LAYOUT = { id: 'json', kind: 'json', title: 'json' } as const

export const PAGE_BLOCK_LAYOUT = {
  text: { ...COMMON_LAYOUT, body: 'rich' },
  table: { ...COMMON_LAYOUT, columns: 'json', rows: 'json' },
  image: { ...COMMON_LAYOUT, fileId: 'json', caption: 'text', width: 'json' },
  file: { ...COMMON_LAYOUT, fileId: 'json' },
  chart: { ...COMMON_LAYOUT, chartId: 'json' },
  map: { ...COMMON_LAYOUT, mapId: 'json', layerId: 'json' },
  dataset: { ...COMMON_LAYOUT, datasetId: 'json', limit: 'json' },
  metric: { ...COMMON_LAYOUT, metricId: 'json' },
  tasks: { ...COMMON_LAYOUT, projectId: 'json' },
} as const satisfies Record<PageBlockKind, Record<string, PageValueKind>>
