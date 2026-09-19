import { type ControlMetricKey, type ControlMetricsState, MetricCreateInput } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Metrics } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'

/** Только основные поручения: части соисполнителей считаются вместе с ними. */
const MAIN = { field: 'is_part', op: 'is_false' } as const

/**
 * Показатели контроля исполнения (08-documents.md §7, ADR-0082) — обычные
 * показатели над системным датасетом «Поручения»: значение, сравнение с прошлым
 * периодом, пороги и плитка дашборда — как у любого показателя, права —
 * смотрящего (руководитель видит поручения подчинённых).
 */
const DEFINITIONS: Record<ControlMetricKey, Record<string, unknown>> = {
  'instructions.overdue': {
    name: 'Просроченные поручения',
    description: 'Открытые поручения, срок которых прошёл (без частей соисполнителей)',
    systemSource: 'instructions',
    definition: {
      measure: { agg: 'count' },
      filter: { and: [MAIN, { field: 'overdue', op: 'is_true' }] },
      timeField: 'due_at',
      dimensions: ['unit', 'assignee', 'controller'],
      period: null,
      comparison: 'none',
    },
    format: { precision: 0 },
    direction: 'down',
    thresholds: [
      { value: 1, status: 'warning' },
      { value: 10, status: 'danger' },
    ],
  },
  'instructions.on_time_rate': {
    name: 'Исполнение поручений в срок',
    description: 'Доля принятых в срок среди принятых поручений со сроком — по дате закрытия',
    systemSource: 'instructions',
    definition: {
      measure: { agg: 'avg', field: 'on_time_score' },
      filter: MAIN,
      timeField: 'completed_at',
      dimensions: ['unit', 'assignee'],
      period: { unit: 'month', from: 0, to: 0 },
      comparison: 'previous_period',
    },
    // Значение — проценты (среднее `on_time_score` 100/0), пороги — тоже
    format: { precision: 0, scale: 'percent' },
    direction: 'up',
    thresholds: [
      { value: 0, status: 'danger' },
      { value: 80, status: 'warning' },
      { value: 95, status: 'success' },
    ],
  },
}

const KEYS = Object.keys(DEFINITIONS) as ControlMetricKey[]

/** Заведённые показатели контроля (не в корзине) — по ключу `meta.systemKey`. */
async function existingMetrics(executor: Executor) {
  return executor
    .select({
      id: objects.id,
      name: objects.title,
      spaceId: objects.spaceId,
      key: sql<ControlMetricKey>`${objects.meta}->>'systemKey'`,
    })
    .from(objects)
    .where(
      and(
        eq(objects.type, 'metric'),
        sql`${objects.deletedAt} IS NULL`,
        inArray(sql`${objects.meta}->>'systemKey'`, KEYS),
      ),
    )
}

/** Заведены ли показатели контроля и где — для консоли (ADR-0082). */
export async function controlMetricsState(executor: Executor = db()): Promise<ControlMetricsState> {
  const byKey = new Map((await existingMetrics(executor)).map((row) => [row.key, row]))
  return {
    items: KEYS.map((key) => {
      const row = byKey.get(key)
      return { key, id: row?.id ?? null, name: row?.name ?? null, spaceId: row?.spaceId ?? null }
    }),
  }
}

/**
 * Завести показатели контроля в пространстве (seed, консоль): уже заведённые
 * по ключу `systemKey` не повторяются.
 */
export async function ensureControlMetrics(
  tx: Executor,
  ctx: Ctx,
  spaceId: string,
): Promise<string[]> {
  const keys = KEYS
  // Два одновременных запуска не заводят показатели дважды
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('tasks:control-metrics'))`)
  const have = new Set((await existingMetrics(tx)).map((row) => row.key))
  const created: string[] = []
  for (const key of keys) {
    if (have.has(key)) continue
    created.push(
      await Metrics.create(tx, ctx, MetricCreateInput.parse({ ...DEFINITIONS[key], spaceId }), {
        systemKey: key,
      }),
    )
  }
  return created
}
