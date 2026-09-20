import type {
  AlertCheckOutcome,
  AlertCheckResult,
  AlertCondition,
  AlertDefinition,
  AlertGroup,
  FilterNode,
  MetricRecord,
  MetricValue,
} from '@kchs/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { Metrics } from '~/modules/data/public.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { alertEvents, alerts, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { type AlertRow, AlertService } from './alert-service.js'
import { anomaly, changePercent, compare, type SeriesPoint } from './anomaly.js'

/**
 * Проверка алерта (06-analytics-engine.md §14, ADR-0104): значение показателя
 * считается тем же кодом, что на дашборде и в карточке, — под правами
 * владельца алерта. Условие проверяется по каждому значению разреза отдельно;
 * срабатывание публикует `alert.fired` в outbox.
 */

/** Разрезов на проверку — не больше: алерт сообщает о главном, а не обо всём. */
const MAX_GROUPS = 20

/** Значений в сообщении — короткое округление, а не полная точность. */
const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100) / 100

const groupLabelOf = (values: Record<string, unknown>): string =>
  Object.values(values)
    .map((item) => (item === null || item === undefined ? '—' : String(item)))
    .join(' · ')

const groupKeyOf = (values: Record<string, unknown>): string =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value === null || value === undefined ? '' : String(value)}`)
    .join('|')

function groupFilter(values: Record<string, unknown>): FilterNode {
  const nodes: FilterNode[] = Object.entries(values).map(([field, value]) =>
    value === null || value === undefined
      ? { field, op: 'is_empty' }
      : { field, op: 'eq', value: value as string | number | boolean },
  )
  return nodes.length === 1 ? (nodes[0] as FilterNode) : { and: nodes }
}

/** Человеку: почему сработало. */
function messageOf(
  metric: MetricRecord,
  condition: AlertCondition,
  outcome: { value: number | null; base: number | null; score: number | null },
  group: AlertGroup,
): string {
  const where = group.key ? ` (${group.label})` : ''
  const value = round(outcome.value) ?? '—'
  switch (condition.kind) {
    case 'threshold': {
      const sign = condition.op.startsWith('g') ? 'выше' : 'ниже'
      return `«${metric.name}»${where}: ${value} — ${sign} порога ${condition.value}`
    }
    case 'change': {
      const percent = round(outcome.score) ?? 0
      const direction = percent >= 0 ? 'выросло' : 'упало'
      return `«${metric.name}»${where}: значение ${direction} на ${Math.abs(percent)} % — ${value} против ${round(outcome.base) ?? '—'}`
    }
    case 'anomaly': {
      const score = round(outcome.score) ?? 0
      return `«${metric.name}»${where}: ${value} — отклонение ${Math.abs(score)} σ от обычного (${round(outcome.base) ?? '—'})`
    }
  }
}

/** Проверка одного значения: сработало ли условие и почему нет. */
function evaluate(
  condition: AlertCondition,
  input: { value: number | null; base: number | null; series: SeriesPoint[] },
): { fired: boolean; score: number | null; base: number | null; reason: string | null } {
  if (condition.kind === 'threshold') {
    if (input.value === null) return { fired: false, score: null, base: null, reason: 'нет значения' }
    return {
      fired: compare(input.value, condition.op, condition.value),
      score: input.value,
      base: condition.value,
      reason: null,
    }
  }
  if (condition.kind === 'change') {
    const percent = changePercent(input.value, input.base)
    if (percent === null) {
      return { fired: false, score: null, base: input.base, reason: 'не с чем сравнивать' }
    }
    const matches =
      condition.direction === 'any'
        ? Math.abs(percent) >= condition.percent
        : condition.direction === 'up'
          ? percent >= condition.percent
          : percent <= -condition.percent
    return { fired: matches, score: percent, base: input.base, reason: null }
  }
  const result = anomaly(input.series, condition)
  if (result.score === null) {
    return { fired: false, score: null, base: result.mean, reason: result.reason }
  }
  return {
    fired: Math.abs(result.score) >= condition.z,
    score: result.score,
    base: result.mean,
    reason: null,
  }
}

const seriesOf = (value: MetricValue): SeriesPoint[] =>
  value.series.map((point) => ({ period: point.period, value: point.value }))

/** Значение показателя с параметрами алерта. */
async function metricValue(
  ctx: UserCtx,
  metric: MetricRecord,
  definition: AlertDefinition,
  options: { filter?: FilterNode; dimensions?: string[]; series: boolean },
): Promise<MetricValue> {
  return Metrics.value(ctx, metric, {
    ...(definition.period !== undefined ? { period: definition.period } : {}),
    ...(definition.condition.kind === 'change'
      ? { comparison: definition.condition.comparison }
      : {}),
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
    series: options.series,
  })
}

/** Когда группа срабатывала в последний раз — для периода тишины. */
async function lastFired(alertId: string, groupKeys: string[]): Promise<Map<string, string>> {
  if (groupKeys.length === 0) return new Map()
  const rows = await db().execute<{ group_key: string; fired_at: string }>(
    sql`select distinct on (group_key) group_key, fired_at
        from alert_events
        where alert_id = ${alertId} and group_key = any(${groupKeys})
        order by group_key, fired_at desc`,
  )
  return new Map(rows.map((row) => [row.group_key, row.fired_at]))
}

export const AlertCheck = {
  /**
   * Проверка алерта. `dryRun` — тестовый прогон: считает и показывает, но не
   * пишет историю, не публикует событие и никого не уведомляет.
   */
  async run(row: AlertRow, options: { dryRun: boolean }): Promise<AlertCheckResult> {
    const definition = AlertService.definitionOf(row)
    const ownerId = row.ownerId
    const ctx = ownerId ? await buildUserCtxFor(ownerId) : null
    const checkedAt = new Date().toISOString()
    if (!ctx) {
      return {
        alertId: row.id,
        checkedAt,
        dryRun: options.dryRun,
        fired: 0,
        outcomes: [
          {
            group: { key: '', label: '', values: {} },
            fired: false,
            value: null,
            base: null,
            score: null,
            reason: 'владелец алерта недоступен',
            suppressed: false,
          },
        ],
      }
    }
    const decision = await authorize(ctx, 'view', definition.metricId, { soft: true })
    if (!decision.allowed) {
      return {
        alertId: row.id,
        checkedAt,
        dryRun: options.dryRun,
        fired: 0,
        outcomes: [
          {
            group: { key: '', label: '', values: {} },
            fired: false,
            value: null,
            base: null,
            score: null,
            reason: 'владелец алерта не видит показатель',
            suppressed: false,
          },
        ],
      }
    }

    const metric = await Metrics.get(definition.metricId)
    const outcomes: AlertCheckOutcome[] = []

    if (definition.dimensions.length === 0) {
      const value = await metricValue(ctx, metric, definition, {
        series: definition.condition.kind === 'anomaly',
      })
      const result = evaluate(definition.condition, {
        value: value.value,
        base: value.base,
        series: seriesOf(value),
      })
      outcomes.push({
        group: { key: '', label: '', values: {} },
        fired: result.fired,
        value: value.value,
        base: result.base,
        score: result.score,
        reason: result.reason,
        suppressed: false,
      })
    } else {
      const breakdown = await metricValue(ctx, metric, definition, {
        dimensions: definition.dimensions,
        series: false,
      })
      for (const item of breakdown.breakdown.slice(0, MAX_GROUPS)) {
        const group: AlertGroup = {
          key: groupKeyOf(item.values),
          label: groupLabelOf(item.values),
          values: item.values,
        }
        let series: SeriesPoint[] = []
        if (definition.condition.kind === 'anomaly') {
          const own = await metricValue(ctx, metric, definition, {
            filter: groupFilter(item.values),
            series: true,
          })
          series = seriesOf(own)
        }
        const result = evaluate(definition.condition, {
          value: item.value,
          base: item.base,
          series,
        })
        outcomes.push({
          group,
          fired: result.fired,
          value: item.value,
          base: result.base,
          score: result.score,
          reason: result.reason,
          suppressed: false,
        })
      }
    }

    const fired = outcomes.filter((item) => item.fired)
    const previous = await lastFired(
      row.id,
      fired.map((item) => item.group.key),
    )
    const cooldownMs = definition.cooldownMinutes * 60_000
    const now = Date.now()
    for (const outcome of fired) {
      const at = previous.get(outcome.group.key)
      if (at && now - Date.parse(at) < cooldownMs) outcome.suppressed = true
    }
    const toFire = fired.filter((item) => !item.suppressed)

    if (!options.dryRun) {
      await db().transaction(async (tx) => {
        const [object] = await tx
          .select({
            id: objects.id,
            type: objects.type,
            spaceId: objects.spaceId,
            title: objects.title,
          })
          .from(objects)
          .where(eq(objects.id, row.id))
          .limit(1)
        if (!object) throw errors.notFound('Алерт')
        const ctxSystem = systemCtx('alerts.check')
        for (const outcome of toFire) {
          const eventId = newId()
          const message = messageOf(metric, definition.condition, outcome, outcome.group)
          const channels = [
            ...(definition.channels.notify ? ['notify'] : []),
            ...(definition.channels.inbox ? ['inbox'] : []),
            ...(definition.channels.email ? ['email'] : []),
          ]
          await tx.insert(alertEvents).values({
            id: eventId,
            alertId: row.id,
            metricId: definition.metricId,
            groupKey: outcome.group.key,
            groupLabel: outcome.group.label,
            groupValues: outcome.group.values,
            value: outcome.value,
            base: outcome.base,
            score: outcome.score,
            message,
            channels,
          })
          await publishEvent(tx, ctxSystem, {
            type: 'alert.fired',
            object,
            payload: {
              alertId: row.id,
              eventId,
              metricId: definition.metricId,
              metricName: metric.name,
              condition: definition.condition.kind,
              groupKey: outcome.group.key,
              groupLabel: outcome.group.label,
              value: outcome.value,
              base: outcome.base,
              score: outcome.score,
              message,
            },
          })
        }
        await tx
          .update(alerts)
          .set({
            lastCheckedAt: checkedAt,
            ...(toFire.length > 0 ? { lastFiredAt: checkedAt } : {}),
          })
          .where(eq(alerts.id, row.id))
      })
    }

    return {
      alertId: row.id,
      checkedAt,
      dryRun: options.dryRun,
      outcomes,
      fired: toFire.length,
    }
  },
}

/** Последние срабатывания алерта — для карточки. */
export async function recentEvents(alertId: string, limit: number) {
  return db()
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.alertId, alertId)))
    .orderBy(desc(alertEvents.firedAt))
    .limit(limit)
}
