import { isKnownEventType, type UserRef } from '@kchs/contracts'
import {
  applyConditions,
  checkDefinition,
  conditionKey,
  type DefinitionIssue,
  dueOf,
  type ProcessDefinition,
  type ProcessDefinitionDetails,
  ProcessDefinition as ProcessDefinitionSchema,
  type ProcessDefinitionSummary,
  type ProcessDefinitionVersion,
  type ProcessDraftSaved,
  type ProcessPreview,
  type ProcessPreviewInput,
  type ProcessValidation,
  resolveAssignees,
  type Step,
  stepAssigneeExpressions,
  validateDefinition,
} from '@kchs/process'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { processDefinitions, processInstances } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { authorize, loadObject } from '../access/authorize.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { BusinessCalendar } from '../business-calendar/service.js'
import { directory } from '../directory/port.js'
import { publishEvent } from '../events/publisher.js'
import { objectType } from '../objects/registry.js'
import { kernelDirectory } from './directory.js'
import { evaluate, evaluationData, loadObjectData } from './engine.js'
import { processObjectProvider, processStepHandler, waitableEvents } from './registry.js'

/**
 * Определения маршрутов с версиями (ADR-0079). Черновик у ключа один и
 * получает следующий номер; публикация замораживает его — идущие экземпляры
 * закреплены за своей версией и не меняются. Черновик хранится, если прошёл
 * схему; публикуется только без ошибок проверки (с учётом зарегистрированных
 * модулями исполнителей шагов).
 */

type DefinitionRow = typeof processDefinitions.$inferSelect

const MISSING_REF = (id: string): UserRef => ({
  id,
  displayName: '—',
  avatarUrl: null,
  position: null,
  unitName: null,
})

/** Ошибки проверки — 400 с проблемами для конструктора. */
function invalid(message: string, issues: DefinitionIssue[]): AppError {
  return new AppError('validation_failed', message, 400, {
    fieldErrors: issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => ({ path: issue.path, message: issue.message, code: issue.code })),
    data: { issues },
  })
}

/** Определение, прошедшее схему; иначе — 400 с проблемами схемы. */
function parsed(raw: unknown): ProcessDefinition {
  const result = validateDefinition(raw)
  if (!result.definition)
    throw invalid('Определение маршрута не соответствует схеме', result.issues)
  return result.definition
}

/** Проверки, которые знает только ядро: тип объекта, исполнители шагов модулей, события ожидания. */
function kernelIssues(def: ProcessDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = []
  if (!objectType(def.objectType)) {
    issues.push({
      path: 'objectType',
      code: 'unknown_object_type',
      message: `Тип объекта «${def.objectType}» не зарегистрирован`,
      severity: 'error',
    })
    return issues
  }
  const provider = processObjectProvider(def.objectType)
  const check = (path: string, step: Step) => {
    if (step.type === 'register' || step.type === 'task' || step.type === 'call') {
      const action = step.type === 'call' ? step.action : undefined
      if (!processStepHandler(step.type, def.objectType, action)) {
        issues.push({
          path,
          code: 'handler_missing',
          message: `Нет исполнителя шага ${step.type}${action ? ` ${action}` : ''} для типа «${def.objectType}»`,
          severity: 'error',
        })
      }
    }
    if (step.type === 'set' && !provider?.setField) {
      issues.push({
        path,
        code: 'set_unsupported',
        message: `Тип «${def.objectType}» не поддерживает изменение поля маршрутом`,
        severity: 'error',
      })
    }
    if (step.type === 'wait' && step.event) {
      if (!isKnownEventType(step.event) || !waitableEvents().includes(step.event)) {
        issues.push({
          path: `${path}.event`,
          code: 'event_not_waitable',
          message: `Событие «${step.event}» маршрут ждать не может`,
          severity: 'error',
        })
      }
    }
  }
  for (const [key, step] of Object.entries(def.steps)) check(`steps.${key}`, step)
  def.conditions.forEach((condition, index) => {
    check(`conditions.${index}.step`, condition.step)
  })
  return issues
}

function allIssues(def: ProcessDefinition): DefinitionIssue[] {
  return [...checkDefinition(def), ...kernelIssues(def)]
}

async function refsOf(ids: Array<string | null>): Promise<Map<string, UserRef>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  return unique.length > 0 ? directory().refs(unique) : new Map()
}

async function running(definitionIds: string[]): Promise<Map<string, number>> {
  if (definitionIds.length === 0) return new Map()
  const rows = await db()
    .select({ definitionId: processInstances.definitionId, count: sql<number>`count(*)::int` })
    .from(processInstances)
    .where(
      and(
        eq(processInstances.status, 'running'),
        inArray(processInstances.definitionId, definitionIds),
      ),
    )
    .groupBy(processInstances.definitionId)
  return new Map(rows.map((row) => [row.definitionId, row.count]))
}

function toVersion(row: DefinitionRow, refs: Map<string, UserRef>): ProcessDefinitionVersion {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    objectType: row.objectType,
    definition: ProcessDefinitionSchema.parse(row.definition),
    publishedAt: row.publishedAt,
    createdBy: row.createdBy ? (refs.get(row.createdBy) ?? MISSING_REF(row.createdBy)) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function rowsOf(executor: Executor, key: string): Promise<DefinitionRow[]> {
  return executor
    .select()
    .from(processDefinitions)
    .where(eq(processDefinitions.key, key))
    .orderBy(desc(processDefinitions.version))
}

export const DefinitionService = {
  async list(): Promise<ProcessDefinitionSummary[]> {
    const rows = await db()
      .select()
      .from(processDefinitions)
      .orderBy(processDefinitions.key, desc(processDefinitions.version))
    const counts = await running(rows.map((row) => row.id))
    const byKey = new Map<string, DefinitionRow[]>()
    for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row])
    return [...byKey.entries()].map(([key, versions]) => {
      const latest = versions[0] as DefinitionRow
      const published = versions.find((row) => row.publishedAt)
      const draft = versions.find((row) => !row.publishedAt)
      const definition = ProcessDefinitionSchema.parse(latest.definition)
      return {
        key,
        objectType: latest.objectType,
        name: definition.name,
        publishedVersion: published?.version ?? null,
        draftVersion: draft?.version ?? null,
        updatedAt: latest.updatedAt,
        running: versions.reduce((sum, row) => sum + (counts.get(row.id) ?? 0), 0),
      }
    })
  },

  async details(key: string): Promise<ProcessDefinitionDetails> {
    const rows = await rowsOf(db(), key)
    const latest = rows[0]
    if (!latest) throw errors.notFound('Маршрут')
    const refs = await refsOf(rows.map((row) => row.createdBy))
    const counts = await running(rows.map((row) => row.id))
    const published = rows.find((row) => row.publishedAt)
    const draft = rows.find((row) => !row.publishedAt)
    return {
      key,
      objectType: latest.objectType,
      name: ProcessDefinitionSchema.parse(latest.definition).name,
      published: published ? toVersion(published, refs) : null,
      draft: draft ? toVersion(draft, refs) : null,
      versions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        publishedAt: row.publishedAt,
        running: counts.get(row.id) ?? 0,
      })),
    }
  },

  async version(key: string, version: number): Promise<ProcessDefinitionVersion> {
    const [row] = await db()
      .select()
      .from(processDefinitions)
      .where(and(eq(processDefinitions.key, key), eq(processDefinitions.version, version)))
      .limit(1)
    if (!row) throw errors.notFound('Версия маршрута')
    return toVersion(row, await refsOf([row.createdBy]))
  },

  /** Новый маршрут: черновик версии 1 под ключом определения. */
  async create(tx: Executor, ctx: Ctx, raw: unknown): Promise<ProcessDraftSaved> {
    const def = parsed(raw)
    const existing = await rowsOf(tx, def.key)
    if (existing.length > 0) throw errors.conflict(`Маршрут с ключом «${def.key}» уже есть`)
    const id = newId()
    await tx.insert(processDefinitions).values({
      id,
      key: def.key,
      version: 1,
      objectType: def.objectType,
      definition: def as unknown as Record<string, unknown>,
      createdBy: actorId(ctx),
      updatedBy: actorId(ctx),
    })
    await publishEvent(tx, ctx, {
      type: 'process.definition_changed',
      payload: { key: def.key, version: 1, change: 'draft_saved' },
    })
    const [row] = await tx.select().from(processDefinitions).where(eq(processDefinitions.id, id))
    return {
      version: toVersion(row as DefinitionRow, await refsOf([actorId(ctx)])),
      issues: allIssues(def),
    }
  },

  /** Сохранить черновик: правка текущего или новый со следующим номером версии. */
  async saveDraft(tx: Executor, ctx: Ctx, key: string, raw: unknown): Promise<ProcessDraftSaved> {
    const def = parsed(raw)
    if (def.key !== key) {
      throw errors.validation('Ключ определения не совпадает с ключом маршрута', [
        { path: 'key', message: 'Ключ менять нельзя' },
      ])
    }
    const rows = await rowsOf(tx, key)
    const latest = rows[0]
    if (!latest) throw errors.notFound('Маршрут')
    if (latest.objectType !== def.objectType) {
      throw errors.validation('Тип объекта маршрута менять нельзя', [
        { path: 'objectType', message: 'Тип объекта менять нельзя' },
      ])
    }
    const draft = rows.find((row) => !row.publishedAt)
    let id: string
    let version: number
    if (draft) {
      id = draft.id
      version = draft.version
      await tx
        .update(processDefinitions)
        .set({
          definition: def as unknown as Record<string, unknown>,
          updatedBy: actorId(ctx),
          updatedAt: sql`now()`,
        })
        .where(eq(processDefinitions.id, draft.id))
    } else {
      id = newId()
      version = latest.version + 1
      await tx.insert(processDefinitions).values({
        id,
        key,
        version,
        objectType: def.objectType,
        definition: def as unknown as Record<string, unknown>,
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
      })
    }
    await publishEvent(tx, ctx, {
      type: 'process.definition_changed',
      payload: { key, version, change: 'draft_saved' },
    })
    const [row] = await tx.select().from(processDefinitions).where(eq(processDefinitions.id, id))
    const saved = row as DefinitionRow
    return { version: toVersion(saved, await refsOf([saved.createdBy])), issues: allIssues(def) }
  },

  async discardDraft(tx: Executor, ctx: Ctx, key: string): Promise<void> {
    const removed = await tx
      .delete(processDefinitions)
      .where(and(eq(processDefinitions.key, key), isNull(processDefinitions.publishedAt)))
      .returning({ version: processDefinitions.version })
    const [row] = removed
    if (!row) throw errors.notFound('Черновик маршрута')
    await publishEvent(tx, ctx, {
      type: 'process.definition_changed',
      payload: { key, version: row.version, change: 'draft_discarded' },
    })
  },

  /** Проверка без сохранения: схема, смысл, исполнители модулей. */
  validate(raw: unknown): ProcessValidation {
    const result = validateDefinition(raw)
    const issues = result.definition
      ? [...result.issues, ...kernelIssues(result.definition)]
      : result.issues
    return { ok: !issues.some((issue) => issue.severity === 'error'), issues }
  },

  /** Публикация черновика: новая версия для новых запусков, идущие — по своей. */
  async publish(tx: Executor, ctx: Ctx, key: string): Promise<ProcessDefinitionVersion> {
    const [draft] = await tx
      .select()
      .from(processDefinitions)
      .where(and(eq(processDefinitions.key, key), isNull(processDefinitions.publishedAt)))
      .for('update')
    if (!draft) throw errors.notFound('Черновик маршрута')
    const def = parsed(draft.definition)
    const issues = allIssues(def)
    if (issues.some((issue) => issue.severity === 'error')) {
      throw invalid('Маршрут содержит ошибки — исправьте их перед публикацией', issues)
    }
    await tx
      .update(processDefinitions)
      .set({ publishedAt: sql`now()`, updatedBy: actorId(ctx), updatedAt: sql`now()` })
      .where(eq(processDefinitions.id, draft.id))
    await publishEvent(tx, ctx, {
      type: 'process.definition_changed',
      payload: { key, version: draft.version, change: 'published' },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.processDefinitionPublished,
        details: { key, version: draft.version, objectType: draft.objectType },
        severity: 'notice',
      },
      tx,
    )
    const [row] = await tx
      .select()
      .from(processDefinitions)
      .where(eq(processDefinitions.id, draft.id))
    const published = row as DefinitionRow
    return toVersion(published, await refsOf([published.createdBy]))
  },

  /** Опубликованная версия для запуска: по идентификатору или последняя по ключу. */
  async published(
    executor: Executor,
    input: { key?: string | undefined; id?: string | undefined },
  ): Promise<DefinitionRow> {
    const condition = input.id
      ? eq(processDefinitions.id, input.id)
      : eq(processDefinitions.key, input.key ?? '')
    const [row] = await executor
      .select()
      .from(processDefinitions)
      .where(and(condition, isNotNull(processDefinitions.publishedAt)))
      .orderBy(desc(processDefinitions.version))
      .limit(1)
    if (!row) throw errors.notFound('Опубликованный маршрут')
    return row
  },

  /**
   * Предпросмотр «кто будет назначен» на примере объекта: условия запуска,
   * назначенные каждого шага и проблемы выражений, сроки, если шаг начнётся
   * сейчас. Назначенные `previous_step.assignees` известны только при исполнении.
   */
  async preview(ctx: UserCtx, input: ProcessPreviewInput): Promise<ProcessPreview> {
    let def: ProcessDefinition | null
    let issues: DefinitionIssue[]
    if (input.definition !== undefined) {
      const result = validateDefinition(input.definition)
      def = result.definition
      issues = def ? [...result.issues, ...kernelIssues(def)] : result.issues
    } else {
      const rows = await rowsOf(db(), input.key ?? '')
      const row =
        input.version !== undefined
          ? rows.find((item) => item.version === input.version)
          : (rows.find((item) => !item.publishedAt) ?? rows[0])
      if (!row) throw errors.notFound('Маршрут')
      def = ProcessDefinitionSchema.parse(row.definition)
      issues = allIssues(def)
    }
    if (!def) return { issues, conditions: [], steps: [] }

    await authorize(ctx, 'view', input.objectId)
    const object = await loadObject(input.objectId)
    if (!object) throw errors.notFound()
    if (object.type !== def.objectType) {
      issues.push({
        path: 'objectType',
        code: 'object_type_mismatch',
        message: `Маршрут для типа «${def.objectType}», а объект — «${object.type}»`,
        severity: 'warning',
      })
    }
    const data = await loadObjectData(db(), object)
    const authorUnit =
      data.authorUnitId !== undefined
        ? data.authorUnitId
        : data.authorId
          ? await directory().primaryUnit(data.authorId)
          : null
    const scope = evaluationData(object, data, input.variables, ctx.userId, authorUnit)
    const conditions = def.conditions.map((condition, index) => ({
      index,
      key: conditionKey(def as ProcessDefinition, index),
      insertBefore: condition.insertBefore,
      matched: evaluate(condition.if, { ...scope }),
      error: null,
    }))
    const effective = applyConditions(
      def,
      conditions.filter((item) => item.matched).map((item) => item.index),
    )
    const inserted = new Set(conditions.filter((item) => item.matched).map((item) => item.key))
    const variableTypes = Object.fromEntries(
      Object.entries(effective.variables).map(([name, variable]) => [name, variable.type]),
    )
    const now = new Date()
    const steps: ProcessPreview['steps'] = []
    for (const [key, step] of Object.entries(effective.steps)) {
      const expressions = stepAssigneeExpressions(step)
      const resolved = await resolveAssignees(
        expressions,
        {
          authorId: data.authorId,
          authorUnitId: authorUnit,
          initiatorId: ctx.userId,
          spaceId: data.spaceId ?? object.spaceId,
          variables: input.variables,
          variableTypes,
          fields: data.fields,
          chosen: input.assignees[key],
          previousAssignees: undefined,
        },
        kernelDirectory,
      )
      const refs = await refsOf(resolved.assignees.map((item) => item.userId))
      const due = dueOf(step)
      steps.push({
        key,
        type: step.type,
        name: step.name ?? null,
        inserted: inserted.has(key),
        assignees: resolved.assignees.map((item) => ({
          user: refs.get(item.userId) ?? MISSING_REF(item.userId),
          source: item.source,
        })),
        issues: resolved.issues,
        dueAt:
          due !== undefined
            ? (await BusinessCalendar.deadline(now, due)).dueAt.toISOString()
            : null,
      })
    }
    return { issues, conditions, steps }
  },
}
