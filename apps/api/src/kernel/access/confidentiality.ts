import {
  CONFIDENTIALITY_LEVELS,
  type Confidentiality,
  clearancesFor,
  confidentialityRank,
  isRedacted,
  type Locale,
  type ObjectSummary,
  parseConfidentiality,
  strictest,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import { adminModeActive, type Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { links, objects } from '~/shared/db/schema/index.js'
import { objectType } from '../objects/registry.js'

/**
 * Грифы и допуски — атрибутное ограничение ядра (03-access-model.md, источник
 * прав №7; ADR-0080). Объект с грифом строже допуска недоступен независимо от
 * владельца, ACL, роли в пространстве и политики типа. Вложение (связь
 * `attachment`) закрыто самым строгим грифом объектов, к которым прикреплено:
 * скан конфиденциального документа не читается в обход документа.
 *
 * Один и тот же допуск применяют `authorize` (через `effectiveLevel`), списки
 * (`clearanceSql`), поиск (ранг `clearance` в индексе), получатели уведомлений,
 * системные датасеты (`clearanceLimit`) и комнаты realtime (через `authorize`).
 */

export { adminModeActive }

/** Допуск запроса: null — без ограничений (системный контекст, режим администратора). */
export function clearanceOf(ctx: Ctx): Confidentiality | null {
  if (ctx.kind === 'system') return null
  if (adminModeActive(ctx)) return null
  return ctx.clearance
}

/** Ранг допуска для фильтров по рангу (поиск, системные датасеты); null — без ограничений. */
export function clearanceLimit(ctx: Ctx): number | null {
  const clearance = clearanceOf(ctx)
  if (!clearance) return null
  const rank = confidentialityRank(clearance)
  return rank >= CONFIDENTIALITY_LEVELS.length - 1 ? null : rank
}

/** Грифы, закрытые допуску запроса; пустой список — ограничений нет. */
export function deniedConfidentiality(ctx: Ctx): Confidentiality[] {
  const clearance = clearanceOf(ctx)
  if (!clearance) return []
  return CONFIDENTIALITY_LEVELS.slice(confidentialityRank(clearance) + 1)
}

/**
 * SQL-предикат допуска над строкой `objects`: свой гриф и гриф объектов, к
 * которым объект прикреплён, не строже допуска. null — ограничений нет.
 * Вложения закрытых хостов — некоррелированный подзапрос: PostgreSQL считает
 * его один раз (хэш по частичному индексу грифа), а не по разу на строку списка.
 * Алиасы cl/ch скрывают внутреннюю `objects`: `${objects.id}` — строка списка.
 */
export function clearanceSql(ctx: Ctx): SQL | null {
  const denied = deniedConfidentiality(ctx)
  if (denied.length === 0) return null
  const list = sql.join(
    denied.map((value) => sql`${value}`),
    sql`, `,
  )
  return sql`(${objects.confidentiality} NOT IN (${list}) AND ${objects.id} NOT IN (
    SELECT cl.target_id FROM ${links} cl JOIN ${objects} ch ON ch.id = cl.source_id
     WHERE cl.kind = 'attachment' AND cl.target_id IS NOT NULL
       AND ch.deleted_at IS NULL AND ch.confidentiality IN (${list})
  ))`
}

/** Грифы объектов, к которым прикреплён данный (связи `attachment`), кроме удалённых. */
async function hostConfidentiality(
  objectIds: string[],
  executor: Executor,
): Promise<Map<string, Confidentiality>> {
  if (objectIds.length === 0) return new Map()
  const rows = await executor
    .select({ targetId: links.targetId, confidentiality: objects.confidentiality })
    .from(links)
    .innerJoin(objects, eq(objects.id, links.sourceId))
    .where(
      and(
        inArray(links.targetId, objectIds),
        eq(links.kind, 'attachment'),
        isNull(objects.deletedAt),
        sql`${objects.confidentiality} <> 'public'`,
      ),
    )
  const result = new Map<string, Confidentiality>()
  for (const row of rows) {
    const level = parseConfidentiality(row.confidentiality, 'public')
    result.set(row.targetId, strictest(result.get(row.targetId) ?? 'public', level))
  }
  return result
}

/** Действующий гриф объекта: свой или самый строгий из объектов-хостов вложения. */
export async function effectiveConfidentiality(
  objectId: string,
  executor: Executor = db(),
): Promise<Confidentiality> {
  const [row] = await executor
    .select({ confidentiality: objects.confidentiality })
    .from(objects)
    .where(eq(objects.id, objectId))
    .limit(1)
  const own = parseConfidentiality(row?.confidentiality, 'public')
  const hosts = await hostConfidentiality([objectId], executor)
  return strictest(own, hosts.get(objectId) ?? 'public')
}

/** Действующие грифы пачки объектов — для сводок, уведомлений и Входящих. */
export async function effectiveConfidentialityMany(
  rows: Array<{ id: string; confidentiality: string }>,
  executor: Executor = db(),
): Promise<Map<string, Confidentiality>> {
  const hosts = await hostConfidentiality(
    rows.map((row) => row.id),
    executor,
  )
  const result = new Map<string, Confidentiality>()
  for (const row of rows) {
    result.set(
      row.id,
      strictest(parseConfidentiality(row.confidentiality, 'public'), hosts.get(row.id) ?? 'public'),
    )
  }
  return result
}

/**
 * Пользователи, чей допуск открывает гриф: фильтр получателей уведомлений.
 * Допуск — атрибут `clearance` учётной записи, по умолчанию `internal`.
 */
export function clearanceAllowsSql(level: Confidentiality, attributes: SQL): SQL | null {
  if (level === 'public') return null
  const allowed = sql.join(
    clearancesFor(level).map((value) => sql`${value}`),
    sql`, `,
  )
  return sql`(COALESCE(${attributes}->>'clearance', 'internal') IN (${allowed}))`
}

/**
 * Название объекта с грифом от «конфиденциально» в уведомлениях, Входящих и
 * внешних каналах — без содержания: «Документ № 01-15/26» (08-documents.md §13).
 */
export function redactedTitle(summary: Pick<ObjectSummary, 'type' | 'subtitle'>, locale: Locale) {
  const t = createTranslator(locale)
  const type = t(objectType(summary.type)?.labelKey ?? 'objects.types.document')
  return summary.subtitle
    ? t('access.redacted.numbered', { type, number: summary.subtitle })
    : t('access.redacted.unnumbered', { type })
}

/** Сводка без содержания для уведомлений и Входящих (заголовок, подзаголовок, meta). */
export function redactSummary(summary: ObjectSummary, locale: Locale): ObjectSummary {
  if (!isRedacted(summary.confidentiality)) return summary
  return {
    ...summary,
    title: redactedTitle(summary, locale),
    subtitle: summary.subtitle,
    meta: {},
    spaceName: null,
  }
}
