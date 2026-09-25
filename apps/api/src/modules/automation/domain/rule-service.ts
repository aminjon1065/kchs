import { randomBytes } from 'node:crypto'
import {
  RULE_EXPORT_FORMAT,
  type RuleAction,
  type RuleCreateInput,
  RuleDefinition,
  type RuleExport,
  type RuleImportInput,
  type RuleListItem,
  type RuleListQuery,
  type RuleRecord,
  type RuleStats,
  type RuleTrigger,
  type RuleTriggerKind,
  type RuleVersionReason,
  type UserRef,
} from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { nextRunAt } from '~/kernel/schedules/index.js'
import { config } from '~/shared/config/index.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, ruleRuns, rules, spaces, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { RuleVersions } from './rule-versions.js'
import { blockingIssues, checkRule, ruleAllowlist } from './validate.js'

/**
 * Правила автоматизации (14-automation-integrations.md §1, ADR-0096).
 * Правило — объект реестра: создаётся через `ObjectService` в той же
 * транзакции, что и строка `rules`, и публикует события `rule.*`.
 */

export interface RuleRow {
  id: string
  key: string
  definition: RuleDefinition
  enabled: boolean
  runAs: string | null
  triggerKind: string
  eventType: string | null
  cron: string | null
  timezone: string | null
  hookKey: string | null
  webhookToken: string | null
  lastRunAt: string | null
  lastStatus: string | null
  spaceId: string | null
  title: string
  ownerId: string | null
  updatedAt: string
}

const selection = {
  id: rules.id,
  key: rules.key,
  definition: rules.definition,
  enabled: rules.enabled,
  runAs: rules.runAs,
  triggerKind: rules.triggerKind,
  eventType: rules.eventType,
  cron: rules.cron,
  timezone: rules.timezone,
  hookKey: rules.hookKey,
  webhookToken: rules.webhookToken,
  lastRunAt: rules.lastRunAt,
  lastStatus: rules.lastStatus,
  spaceId: objects.spaceId,
  title: objects.title,
  ownerId: objects.ownerId,
  updatedAt: objects.updatedAt,
}

function asRow(row: Record<string, unknown>): RuleRow {
  return { ...(row as unknown as RuleRow) }
}

/** Денормализация определения в столбцы: по ним ищут подписчик и планировщик. */
function triggerColumns(trigger: RuleTrigger): {
  triggerKind: RuleTriggerKind
  eventType: string | null
  cron: string | null
  timezone: string | null
  hookKey: string | null
} {
  return {
    triggerKind: trigger.kind,
    eventType: trigger.kind === 'event' ? trigger.type : null,
    cron: trigger.kind === 'schedule' || trigger.kind === 'metric' ? trigger.cron : null,
    timezone: trigger.kind === 'schedule' || trigger.kind === 'metric' ? trigger.timezone : null,
    hookKey: trigger.kind === 'webhook' ? trigger.hookKey : null,
  }
}

export function triggerSummary(definition: RuleDefinition): string {
  const trigger = definition.trigger
  switch (trigger.kind) {
    case 'event':
      return trigger.type
    case 'schedule':
      return `${trigger.cron} (${trigger.timezone})`
    case 'webhook':
      return trigger.hookKey
    case 'manual':
      return trigger.objectTypes.join(', ')
    case 'metric':
      return `${trigger.cron} · ${trigger.condition}`
  }
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base.length > 0 ? base : 'rule'
}

/**
 * Служебный пользователь правила — служебная учётная запись (ADR-0130):
 * действующая, без прав администратора системы. Правило не должно уметь
 * больше, чем человек (contracts/automation-rule.md §Правила исполнения), и не
 * работает от имени живого сотрудника: его уход или смена ролей не должны
 * незаметно менять поведение правил.
 */
function runAsError(message: string) {
  return errors.validation(message, [{ path: 'runAs', message }])
}

export async function assertRunAs(userId: string): Promise<void> {
  const [user] = await db()
    .select({ status: users.status, kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) throw runAsError('Служебный пользователь не найден')
  if (user.kind !== 'service') {
    throw runAsError(
      'Правило работает только от имени служебной учётной записи: заведите её в консоли администрирования',
    )
  }
  if (user.status !== 'active') throw runAsError('Служебный пользователь отключён')
  const ctx = await buildUserCtxFor(userId)
  if (!ctx) throw runAsError('Служебный пользователь не найден')
  if (ctx.isSystemAdmin) {
    throw runAsError(
      'Правило не работает от имени администратора системы: заведите служебную учётную запись с нужными правами',
    )
  }
}

async function stats(ruleIds: readonly string[]): Promise<Map<string, RuleStats>> {
  const out = new Map<string, RuleStats>()
  if (ruleIds.length === 0) return out
  const rows = await db()
    .select({
      ruleId: ruleRuns.ruleId,
      status: ruleRuns.status,
      total: count(),
    })
    .from(ruleRuns)
    .where(
      and(
        inArray(ruleRuns.ruleId, [...ruleIds]),
        sql`${ruleRuns.createdAt} > now() - interval '24 hours'`,
      ),
    )
    .groupBy(ruleRuns.ruleId, ruleRuns.status)

  for (const id of ruleIds) {
    out.set(id, { runs: 0, failures: 0, skipped: 0, lastRunAt: null, lastStatus: null })
  }
  for (const row of rows) {
    const item = out.get(row.ruleId)
    if (!item) continue
    item.runs += row.total
    if (row.status === 'failed') item.failures += row.total
    if (row.status === 'skipped') item.skipped += row.total
  }
  return out
}

function webhookUrl(row: RuleRow): string | null {
  if (row.triggerKind !== 'webhook' || !row.webhookToken) return null
  const base = config().KCHS_BASE_URL.replace(/\/+$/, '')
  return `${base}/api/v1/hooks/rules/${row.id}/${row.webhookToken}`
}

async function toListItem(
  row: RuleRow,
  extras: { stats: RuleStats; refs: Map<string, UserRef>; spaceName: string | null },
): Promise<RuleListItem> {
  const definition = RuleDefinition.parse(row.definition)
  return {
    id: row.id,
    key: row.key,
    spaceId: row.spaceId,
    spaceName: extras.spaceName,
    name: definition.name,
    description: definition.description,
    enabled: row.enabled,
    triggerKind: row.triggerKind as RuleTriggerKind,
    triggerSummary: triggerSummary(definition),
    actionTypes: definition.actions.map((action) => action.type),
    runAs: row.runAs ? (extras.refs.get(row.runAs) ?? null) : null,
    ownerId: row.ownerId,
    stats: {
      ...extras.stats,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
    },
    nextRunAt: row.enabled && row.cron && row.timezone ? nextRunAt(row.cron, row.timezone) : null,
    updatedAt: row.updatedAt,
  }
}

/** Заголовки вебхука, похожие на ключи доступа: в файл правила не попадают. */
const SECRET_HEADER = /authorization|token|secret|key|cookie|password/i

function withoutSecrets(action: RuleAction): RuleAction {
  if (action.type !== 'webhook') return action
  return {
    ...action,
    secret: null,
    headers: Object.fromEntries(
      Object.entries(action.headers).map(([name, value]) => [
        name,
        SECRET_HEADER.test(name) ? '' : value,
      ]),
    ),
  }
}

/**
 * Определение для переноса между установками (ADR-0163): без секретов и привязки к людям —
 * служебный пользователь снят, правило выключено, секрет подписи и ключи в заголовках пусты.
 */
export function exportableDefinition(definition: RuleDefinition): RuleDefinition {
  return {
    ...definition,
    enabled: false,
    runAs: null,
    actions: definition.actions.map(withoutSecrets),
    otherwise: definition.otherwise.map(withoutSecrets),
  }
}

/** Пометка копии в названии — на языке каждой подписи. */
const COPY_LABEL: Record<string, string> = { ru: 'копия', tg: 'нусха', en: 'copy' }

/** Поля определения, изменение которых — новая версия правила. */
const VERSIONED_FIELDS = [
  'name',
  'description',
  'trigger',
  'conditions',
  'actions',
  'otherwise',
  'limits',
  'runAs',
] as const

export const RuleService = {
  async load(executor: Executor, id: string): Promise<RuleRow | null> {
    const [row] = await executor
      .select(selection)
      .from(rules)
      .innerJoin(objects, eq(objects.id, rules.id))
      .where(eq(rules.id, id))
      .limit(1)
    return row ? asRow(row) : null
  },

  async byHookKey(hookKey: string): Promise<RuleRow[]> {
    const rows = await db()
      .select(selection)
      .from(rules)
      .innerJoin(objects, eq(objects.id, rules.id))
      .where(and(eq(rules.hookKey, hookKey), eq(rules.enabled, true)))
    return rows.map(asRow)
  },

  /** Включённые правила с триггером по событию: подписчик читает их из кэша. */
  async enabledEventRules(): Promise<RuleRow[]> {
    const rows = await db()
      .select(selection)
      .from(rules)
      .innerJoin(objects, eq(objects.id, rules.id))
      .where(
        and(eq(rules.enabled, true), eq(rules.triggerKind, 'event'), isNull(objects.deletedAt)),
      )
    return rows.map(asRow)
  },

  async create(
    tx: Executor,
    ctx: UserCtx,
    input: RuleCreateInput,
    reason: RuleVersionReason = 'create',
  ): Promise<string> {
    const definition = RuleDefinition.parse(input.definition)
    const blocking = blockingIssues(
      checkRule(definition, await ruleAllowlist()),
      definition.enabled,
    )
    if (blocking.length > 0) {
      throw errors.validation(
        `Правило не сохранено: ${blocking[0]?.message ?? ''}`,
        blocking.map((issue) => ({ path: issue.path, message: issue.message })),
      )
    }
    if (definition.runAs) await assertRunAs(definition.runAs)

    const title = localizedText(definition.name, 'ru')
    // Хвост идентификатора, а не начало: у UUIDv7 начало — время, и правила, созданные
    // в одну миллисекунду с одним названием (копия, импорт), получали бы один ключ
    const key = input.key ?? `${slugify(title)}-${newId().slice(-8)}`
    const object = await ObjectService.create(tx, ctx, {
      type: 'rule',
      spaceId: input.spaceId,
      title,
      subtitle: definition.description,
      meta: { triggerKind: definition.trigger.kind, enabled: definition.enabled },
    })

    const columns = triggerColumns(definition.trigger)
    await tx.insert(rules).values({
      id: object.id,
      key,
      definition: definition as unknown as Record<string, unknown>,
      enabled: definition.enabled,
      runAs: definition.runAs,
      ...columns,
      webhookToken: columns.triggerKind === 'webhook' ? randomBytes(24).toString('hex') : null,
    })

    await RuleVersions.record(tx, ctx, object.id, definition, reason)

    await publishEvent(tx, ctx, {
      type: 'rule.created',
      object: { id: object.id, type: 'rule', spaceId: object.spaceId, title },
      payload: { key, triggerKind: definition.trigger.kind },
    })
    return object.id
  },

  async update(
    tx: Executor,
    ctx: UserCtx,
    id: string,
    next: RuleDefinition,
    reason: RuleVersionReason = 'update',
  ): Promise<void> {
    const current = await RuleService.load(tx, id)
    if (!current) throw errors.notFound('Правило')
    const definition = RuleDefinition.parse(next)
    const blocking = blockingIssues(
      checkRule(definition, await ruleAllowlist()),
      definition.enabled,
    )
    if (blocking.length > 0) {
      throw errors.validation(
        `Правило не сохранено: ${blocking[0]?.message ?? ''}`,
        blocking.map((issue) => ({ path: issue.path, message: issue.message })),
      )
    }
    if (definition.runAs) await assertRunAs(definition.runAs)

    const previous = RuleDefinition.parse(current.definition)
    const changed = VERSIONED_FIELDS.filter(
      (field) => JSON.stringify(previous[field]) !== JSON.stringify(definition[field]),
    ).map(String)

    const title = localizedText(definition.name, 'ru')
    const columns = triggerColumns(definition.trigger)
    await tx
      .update(rules)
      .set({
        definition: definition as unknown as Record<string, unknown>,
        enabled: definition.enabled,
        runAs: definition.runAs,
        ...columns,
        webhookToken:
          columns.triggerKind === 'webhook'
            ? (current.webhookToken ?? randomBytes(24).toString('hex'))
            : null,
        updatedAt: sql`now()`,
      })
      .where(eq(rules.id, id))
    await ObjectService.update(tx, ctx, id, {
      title,
      subtitle: definition.description,
      meta: { triggerKind: definition.trigger.kind, enabled: definition.enabled },
      mergeMeta: true,
    })

    if (changed.length > 0 || reason === 'restore') {
      await RuleVersions.record(tx, ctx, id, definition, reason, changed)
    }

    await publishEvent(tx, ctx, {
      type: 'rule.updated',
      object: { id, type: 'rule', spaceId: current.spaceId, title },
      payload: { key: current.key, changed },
    })
    if (previous.enabled !== definition.enabled) {
      await publishEvent(tx, ctx, {
        type: definition.enabled ? 'rule.enabled' : 'rule.disabled',
        object: { id, type: 'rule', spaceId: current.spaceId, title },
        payload: { key: current.key },
      })
    }
  },

  async setEnabled(tx: Executor, ctx: Ctx, id: string, enabled: boolean): Promise<void> {
    const row = await RuleService.load(tx, id)
    if (!row) throw errors.notFound('Правило')
    if (row.enabled === enabled) return
    const definition = RuleDefinition.parse(row.definition)
    if (enabled && !definition.runAs) {
      throw runAsError('Укажите служебного пользователя правила')
    }
    if (enabled && definition.runAs) await assertRunAs(definition.runAs)
    if (enabled) {
      // Белый список мог сузиться, пока правило было выключено (ADR-0141)
      const [blocking] = blockingIssues(checkRule(definition, await ruleAllowlist()), true)
      if (blocking) {
        throw errors.validation(`Правило не включено: ${blocking.message}`, [
          { path: blocking.path, message: blocking.message },
        ])
      }
    }

    await tx
      .update(rules)
      .set({
        enabled,
        definition: { ...definition, enabled } as unknown as Record<string, unknown>,
        updatedAt: sql`now()`,
      })
      .where(eq(rules.id, id))
    await ObjectService.update(
      tx,
      ctx,
      id,
      { meta: { enabled }, mergeMeta: true },
      { silent: true },
    )
    await publishEvent(tx, ctx, {
      type: enabled ? 'rule.enabled' : 'rule.disabled',
      object: { id, type: 'rule', spaceId: row.spaceId, title: row.title },
      payload: { key: row.key },
    })
  },

  async get(ctx: UserCtx, id: string): Promise<RuleRecord> {
    const row = await RuleService.load(db(), id)
    if (!row) throw errors.notFound('Правило')
    const [statsMap, refs, spaceName, decision] = await Promise.all([
      stats([id]),
      row.runAs ? directory().refs([row.runAs]) : Promise.resolve(new Map<string, UserRef>()),
      spaceTitle(row.spaceId),
      authorize(ctx, 'manage', id, { soft: true }),
    ])
    const item = await toListItem(row, {
      stats: statsMap.get(id) ?? {
        runs: 0,
        failures: 0,
        skipped: 0,
        lastRunAt: null,
        lastStatus: null,
      },
      refs,
      spaceName,
    })
    return {
      ...item,
      definition: RuleDefinition.parse(row.definition),
      webhookUrl: webhookUrl(row),
      canManage: decision.allowed,
    }
  },

  async list(
    ctx: UserCtx,
    query: RuleListQuery,
  ): Promise<{ items: RuleListItem[]; total: number }> {
    const conditions = [isNull(objects.deletedAt), visibleObjectsSql(ctx, 'rule')]
    if (query.spaceId) conditions.push(eq(objects.spaceId, query.spaceId))
    if (query.triggerKind) conditions.push(eq(rules.triggerKind, query.triggerKind))
    if (query.enabled !== undefined) conditions.push(eq(rules.enabled, query.enabled))
    if (query.q) {
      const like = `%${query.q}%`
      conditions.push(or(ilike(objects.title, like), ilike(rules.key, like)) as never)
    }
    const where = and(...conditions)

    const [{ total = 0 } = { total: 0 }] = await db()
      .select({ total: count() })
      .from(rules)
      .innerJoin(objects, eq(objects.id, rules.id))
      .where(where)

    const rows = await db()
      .select(selection)
      .from(rules)
      .innerJoin(objects, eq(objects.id, rules.id))
      .where(where)
      .orderBy(desc(objects.updatedAt))
      .limit(query.limit)
      .offset(query.offset)

    const list = rows.map(asRow)
    const statsMap = await stats(list.map((row) => row.id))
    const refs = await directory().refs(
      list.map((row) => row.runAs).filter((id): id is string => Boolean(id)),
    )
    const spaceNames = await spaceTitles(list.map((row) => row.spaceId))
    const items = await Promise.all(
      list.map((row) =>
        toListItem(row, {
          stats: statsMap.get(row.id) ?? {
            runs: 0,
            failures: 0,
            skipped: 0,
            lastRunAt: null,
            lastStatus: null,
          },
          refs,
          spaceName: row.spaceId ? (spaceNames.get(row.spaceId) ?? null) : null,
        }),
      ),
    )
    return { items, total }
  },

  /** Правила с ручным запуском для типа объекта. */
  async manualFor(objectType: string): Promise<RuleRow[]> {
    const rows = await db()
      .select(selection)
      .from(rules)
      .innerJoin(objects, eq(objects.id, rules.id))
      .where(
        and(
          eq(rules.enabled, true),
          eq(rules.triggerKind, 'manual'),
          isNull(objects.deletedAt),
          sql`${rules.definition} #> '{trigger,objectTypes}' @> ${JSON.stringify([objectType])}::jsonb`,
        ),
      )
    return rows.map(asRow)
  },

  /** Копия правила в том же пространстве: выключена, с пометкой в названии. */
  async duplicate(tx: Executor, ctx: UserCtx, id: string): Promise<string> {
    const row = await RuleService.load(tx, id)
    if (!row?.spaceId) throw errors.notFound('Правило')
    const definition = RuleDefinition.parse(row.definition)
    const name = Object.fromEntries(
      Object.entries(definition.name).map(([locale, text]) => [
        locale,
        typeof text === 'string' && text
          ? `${text} (${COPY_LABEL[locale] ?? COPY_LABEL.ru})`
          : text,
      ]),
    ) as RuleDefinition['name']
    return RuleService.create(
      tx,
      ctx,
      { spaceId: row.spaceId, definition: { ...definition, name, enabled: false } },
      'duplicate',
    )
  },

  /** Откат к версии: определение версии становится новой версией, состояние — текущее. */
  async restore(tx: Executor, ctx: UserCtx, id: string, versionId: string): Promise<void> {
    const row = await RuleService.load(tx, id)
    if (!row) throw errors.notFound('Правило')
    const version = await RuleVersions.get(id, versionId)
    if (!version) throw errors.notFound('Версия правила')
    await RuleService.update(tx, ctx, id, { ...version, enabled: row.enabled }, 'restore')
  },

  /** Файл одного правила (ADR-0163): определение без секретов и привязок к людям. */
  async exportRule(id: string): Promise<RuleExport> {
    const row = await RuleService.load(db(), id)
    if (!row) throw errors.notFound('Правило')
    return {
      format: RULE_EXPORT_FORMAT,
      version: 1,
      key: row.key,
      exportedAt: new Date().toISOString(),
      definition: exportableDefinition(RuleDefinition.parse(row.definition)),
    }
  },

  /** Правило из файла: выключенным, без служебного пользователя; занятый ключ — новый. */
  async importRule(tx: Executor, ctx: UserCtx, input: RuleImportInput): Promise<string> {
    const [taken] = await tx
      .select({ id: rules.id })
      .from(rules)
      .where(eq(rules.key, input.rule.key))
      .limit(1)
    return RuleService.create(
      tx,
      ctx,
      {
        spaceId: input.spaceId,
        ...(taken ? {} : { key: input.rule.key }),
        definition: exportableDefinition(RuleDefinition.parse(input.rule.definition)),
      },
      'import',
    )
  },

  /** Отметка последнего запуска — колонка «Здоровье» в списке. */
  async markRun(executor: Executor, id: string, status: string): Promise<void> {
    await executor
      .update(rules)
      .set({ lastRunAt: sql`now()`, lastStatus: status })
      .where(eq(rules.id, id))
  },
}

async function spaceTitle(spaceId: string | null): Promise<string | null> {
  if (!spaceId) return null
  return (await spaceTitles([spaceId])).get(spaceId) ?? null
}

async function spaceTitles(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (unique.length === 0) return new Map()
  const rows = await db()
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .innerJoin(spaces, eq(spaces.id, objects.id))
    .where(inArray(objects.id, unique))
  return new Map(rows.map((row) => [row.id, row.title]))
}
