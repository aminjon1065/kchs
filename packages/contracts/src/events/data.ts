import { z } from 'zod'
import { Uuid } from '../common/primitives.js'
import { DatasetRowEvent } from './shared.js'

/**
 * События: Модуль «Данные» (06-analytics-engine.md). Домены `dataset`, `chart`, `dashboard`, `metric`, `notebook`, `analysis`, `pipeline`, `source` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const DATA_EVENTS = {
  // ── dataset (06-analytics-engine.md) ──────────────────────────────────────
  'dataset.created': z.object({ name: z.string(), fields: z.number().int() }),
  'dataset.schema_changed': z.object({
    change: z.enum(['added', 'updated', 'removed', 'type_changed']),
    fields: z.array(z.string()),
  }),
  'dataset.import_started': z.object({ importId: Uuid, mode: z.string() }),
  'dataset.imported': z.object({
    importId: Uuid,
    version: z.number().int(),
    mode: z.string(),
    rows: z.number().int(),
    inserted: z.number().int(),
    updated: z.number().int(),
    deleted: z.number().int(),
    errors: z.number().int(),
  }),
  'dataset.import_failed': z.object({ importId: Uuid, reason: z.string() }),
  /** Сводка изменений готова, импорт ждёт публикации (ADR-0068). */
  'dataset.import_review': z.object({
    importId: Uuid,
    added: z.number().int(),
    changed: z.number().int(),
    deleted: z.number().int(),
  }),
  'dataset.import_published': z.object({ importId: Uuid }),
  'dataset.import_cancelled': z.object({ importId: Uuid }),
  'dataset.rows_changed': z.object({
    op: z.enum(['insert', 'update', 'delete']),
    ids: z.array(z.string()).max(1000),
    count: z.number().int(),
  }),
  /**
   * Строка датасета с включёнными событиями строк (ADR-0133): значения полей без
   * чувствительных, подписи вариантов и территорий, территории с кодом и путём кодами
   * от страны — правило отбирает строки по значениям. Правка больше 200 строк за раз
   * публикует только `dataset.rows_changed`.
   */
  'dataset.row_created': DatasetRowEvent,
  /** Правка строки: полные значения после неё, изменённые поля и их прежние значения. */
  'dataset.row_updated': DatasetRowEvent.extend({
    changed: z.array(z.string()),
    previous: z.record(z.string(), z.unknown()),
  }),
  'dataset.row_deleted': DatasetRowEvent,
  'dataset.version_created': z.object({ version: z.number().int(), origin: z.string() }),
  /** Правила качества датасета изменены (ADR-0101). */
  'dataset.quality_rules_changed': z.object({ rules: z.number().int() }),
  /** Проверка качества прошла: статус версии и сколько правил не выполнилось. */
  'dataset.quality_checked': z.object({
    version: z.number().int(),
    status: z.enum(['unknown', 'ok', 'warning', 'failed']),
    failed: z.number().int(),
  }),
  /** Сборка колоночной копии поставлена (ADR-0109). */
  'dataset.columnar_build_started': z.object({ version: z.number().int() }),
  /** Колоночная копия собрана: версия данных и число строк в копии. */
  'dataset.columnar_built': z.object({ version: z.number().int(), rows: z.number().int() }),
  'dataset.rolled_back': z.object({
    version: z.number().int(),
    target: z.number().int(),
    from: z.number().int(),
  }),
  'dataset.policies_changed': z.object({
    kind: z.enum(['rows', 'columns']),
    op: z.enum(['created', 'updated', 'deleted']),
    policyId: Uuid,
  }),
  'chart.updated': z.object({ changed: z.array(z.string()) }),
  'dashboard.updated': z.object({ changed: z.array(z.string()) }),
  'metric.updated': z.object({ changed: z.array(z.string()) }),
  /** Снимок тетради после совместной правки (ADR-0070): что изменилось — ячейки, параметры. */
  'notebook.updated': z.object({ changed: z.array(z.enum(['cells', 'params'])) }),

  // ── gis: пространственный анализ (07-gis-engine.md §10, ADR-0069) ──────────
  'analysis.created': z.object({ kind: z.string(), datasetIds: z.array(Uuid) }),
  /** Запуск поставлен в очередь (создание с запуском или перезапуск). */
  'analysis.queued': z.object({ jobId: Uuid }),
  'analysis.started': z.object({ jobId: Uuid }),
  'analysis.finished': z.object({
    jobId: Uuid,
    status: z.enum(['succeeded', 'failed']),
    datasetId: Uuid.nullable(),
    rows: z.number().int().nullable(),
    error: z.string().nullable(),
  }),

  // ── пайплайны преобразований (06-analytics-engine.md §16, ADR-0106) ───────
  'pipeline.created': z.object({ steps: z.number().int(), datasetIds: z.array(Uuid) }),
  /** Определение, расписание или включение изменены. */
  'pipeline.updated': z.object({ changed: z.array(z.string()) }),
  'pipeline.queued': z.object({ jobId: Uuid, runId: Uuid, trigger: z.string() }),
  'pipeline.started': z.object({ jobId: Uuid, runId: Uuid }),
  'pipeline.finished': z.object({
    jobId: Uuid,
    runId: Uuid,
    status: z.enum(['succeeded', 'failed']),
    datasetId: Uuid.nullable(),
    rows: z.number().int().nullable(),
    error: z.string().nullable(),
  }),

  // ── источники датасетов из внешних БД (14-…md §5, ADR-0107) ───────────────
  /** У ленты по адресу (ADR-0132) интеграции может не быть. */
  'source.created': z.object({
    kind: z.string(),
    integrationId: Uuid.nullable(),
    mode: z.string(),
  }),
  'source.updated': z.object({ changed: z.array(z.string()) }),
  'source.queued': z.object({ jobId: Uuid, runId: Uuid, mode: z.string() }),
  'source.synced': z.object({
    jobId: Uuid,
    runId: Uuid,
    datasetId: Uuid,
    rows: z.number().int(),
    inserted: z.number().int(),
    updated: z.number().int(),
    version: z.number().int(),
  }),
  'source.failed': z.object({ jobId: Uuid.nullable(), runId: Uuid, error: z.string() }),
} as const satisfies Record<string, z.ZodType>
