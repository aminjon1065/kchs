import {
  type Confidentiality,
  type DocumentRouteChoice,
  type DocumentRouteOptions,
  type DocumentRouteStartInput,
  type DocumentStatus,
  parseConfidentiality,
  withinClearance,
} from '@kchs/contracts'
import {
  applyConditions,
  assigneeNodes,
  conditionKey,
  isDecisionStep,
  nextOf,
  type ProcessDefinition,
  type ProcessPreview,
  parseAssignee,
  type Step,
  stepAssigneeExpressions,
} from '@kchs/process'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { directory } from '~/kernel/directory/port.js'
import { ProcessDefinitions, ProcessService } from '~/kernel/process/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { assertRequisites, validateCardFields } from '../card.js'
import { DocumentService } from '../document-service.js'
import { DocumentTypeService } from '../type-service.js'
import { routeBlocker } from './state.js'

/** Объект маршрутов документа — тип реестра `document`. */
export const DOCUMENT_OBJECT_TYPE = 'document'

type Published = Awaited<ReturnType<typeof ProcessDefinitions.published>>[number]

/** Шаги, исполнителей которых выбирает инициатор (`chosen_by_initiator`). */
function choicesOf(def: ProcessDefinition): DocumentRouteChoice[] {
  const steps: Array<[string, Step]> = Object.entries(def.steps)
  def.conditions.forEach((condition, index) => {
    steps.push([conditionKey(def, index), condition.step as Step])
  })
  const result: DocumentRouteChoice[] = []
  for (const [key, step] of steps) {
    const expressions = stepAssigneeExpressions(step)
    const choosing = expressions.some((source) => {
      try {
        return assigneeNodes(parseAssignee(source)).some(
          (node) => node.kind === 'chosen_by_initiator',
        )
      } catch {
        return false
      }
    })
    if (!choosing) continue
    result.push({
      stepKey: key,
      type: step.type,
      name: step.name ?? null,
      required: expressions.length === 1,
    })
  }
  return result
}

/**
 * Шаги, до которых маршрут доходит без условий: от начала по `next` и ветвям
 * параллельных шагов, не заходя в условия и возвраты. Их назначенные должны
 * определиться при запуске — иначе маршрут встанет на полпути.
 */
export function unconditionalSteps(def: ProcessDefinition): Set<string> {
  const seen = new Set<string>()
  const queue = [def.start]
  while (queue.length > 0) {
    const key = queue.shift() as string
    if (seen.has(key)) continue
    const step = def.steps[key]
    if (!step) continue
    seen.add(key)
    if (step.type === 'condition' || step.type === 'return' || step.type === 'end') continue
    if (step.type === 'parallel') for (const branch of step.branches) queue.push(...branch)
    const next = nextOf(step)
    if (next) queue.push(next)
  }
  return seen
}

/** Сотрудники без допуска к грифу документа — согласовать вслепую они не должны. */
export async function withoutClearance(
  userIds: readonly string[],
  confidentiality: Confidentiality,
): Promise<string[]> {
  if (confidentiality === 'public') return []
  const denied: string[] = []
  for (const userId of new Set(userIds)) {
    const ctx = await buildUserCtxFor(userId)
    if (!ctx || !withinClearance(confidentiality, ctx.clearance)) denied.push(userId)
  }
  return denied
}

async function names(userIds: string[]): Promise<string> {
  const refs = await directory().refs(userIds)
  return userIds.map((id) => refs.get(id)?.displayName ?? '—').join(', ')
}

/** Сообщение о том, почему маршрут не запустить. */
const BLOCKED: Record<string, string> = {
  access: 'Отправить документ по маршруту может тот, кто вправе его править',
  running: 'По документу уже идёт маршрут',
  status: 'Документ в этом статусе по маршруту не отправляется',
  no_version: 'Приложите файл документа: по маршруту идёт версия',
}

/**
 * Маршруты документа из карточки (08-documents.md §4, ADR-0083): список
 * опубликованных маршрутов, предпросмотр «кто будет назначен», запуск.
 * Линию шагов и решения отдаёт общее API движка процессов.
 */
export const DocumentRoutes = {
  async published(executor: Executor): Promise<Published[]> {
    return ProcessDefinitions.published(executor, DOCUMENT_OBJECT_TYPE)
  },

  /** Почему пользователь не может отправить документ по маршруту; null — может. */
  async blocker(executor: Executor, ctx: UserCtx, documentId: string) {
    const row = await DocumentService.load(executor, documentId)
    if (!row) throw errors.notFound('Документ')
    const edit = await authorize(ctx, 'edit', documentId, { soft: true })
    const running = await ProcessService.running(executor, documentId)
    return routeBlocker({
      canEdit: edit.allowed,
      status: row.status as DocumentStatus,
      running: running.length > 0,
      hasVersion: row.currentVersionId !== null,
    })
  },

  /** Запуск через общее API движка — те же проверки, что у карточки. */
  async assertCanStart(executor: Executor, ctx: UserCtx, documentId: string): Promise<void> {
    await authorize(ctx, 'view', documentId)
    const blocker = await DocumentRoutes.blocker(executor, ctx, documentId)
    if (blocker === 'access') throw errors.forbidden(BLOCKED.access as string)
    if (blocker) throw errors.conflict(BLOCKED[blocker] as string, { reason: blocker })
  },

  async options(ctx: UserCtx, documentId: string): Promise<DocumentRouteOptions> {
    await authorize(ctx, 'view', documentId)
    const row = await DocumentService.load(db(), documentId)
    if (!row) throw errors.notFound('Документ')
    const type = await DocumentTypeService.load(db(), row.typeId)
    const blocker = await DocumentRoutes.blocker(db(), ctx, documentId)
    const published = await DocumentRoutes.published(db())
    const items = published
      .map(({ key, version, definition }) => ({
        key,
        version,
        name: definition.name,
        description: definition.description ?? null,
        isDefault: key === type?.defaultRouteKey,
        variables: Object.entries(definition.variables).map(([name, variable]) => ({
          name,
          type: variable.type,
          label: variable.label,
          description: variable.description ?? null,
          required: variable.required,
        })),
        choices: choicesOf(definition),
      }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.key.localeCompare(b.key))
    return { canStart: blocker === null && items.length > 0, blocker, items }
  },

  /** «Кто будет назначен» на этом документе — опубликованная версия маршрута. */
  async preview(
    ctx: UserCtx,
    documentId: string,
    input: DocumentRouteStartInput,
  ): Promise<ProcessPreview> {
    await authorize(ctx, 'edit', documentId)
    const definition = (await DocumentRoutes.published(db())).find(
      (item) => item.key === input.definitionKey,
    )
    if (!definition) throw errors.notFound('Опубликованный маршрут')
    return ProcessDefinitions.preview(ctx, {
      key: definition.key,
      version: definition.version,
      objectId: documentId,
      variables: input.variables,
      assignees: input.assignees,
    })
  },

  /**
   * «Отправить на согласование»: проверки карточки и назначенных до запуска,
   * затем `ProcessService.start` в той же транзакции — статус и заморозку
   * версии делают хуки поставщика `document`.
   */
  async start(
    tx: Executor,
    ctx: UserCtx,
    documentId: string,
    input: DocumentRouteStartInput,
  ): Promise<{ instanceId: string }> {
    await authorize(ctx, 'view', documentId)
    // Строка документа заблокирована: два запуска подряд не проскочат проверку
    const row = await DocumentService.load(tx, documentId, true)
    if (!row) throw errors.notFound('Документ')
    await DocumentRoutes.assertCanStart(tx, ctx, documentId)
    const published = (await DocumentRoutes.published(tx)).find(
      (item) => item.key === input.definitionKey,
    )
    if (!published) throw errors.notFound('Опубликованный маршрут')
    const def = published.definition
    const allSteps = [
      ...Object.values(def.steps),
      ...def.conditions.map((condition) => condition.step as Step),
    ]
    if (allSteps.some((step) => step.type === 'sign' && step.signatureKind === 'qualified')) {
      throw errors.conflict('Квалифицированная подпись не подключена — маршрут не запускается', {
        reason: 'qualified_signature',
      })
    }
    // Маршрут с регистрацией: карточка должна пройти проверки регистрации заранее
    if (allSteps.some((step) => step.type === 'register')) {
      const type = await DocumentTypeService.load(tx, row.typeId)
      if (!type) throw errors.notFound('Тип документа')
      assertRequisites(type.direction, row)
      validateCardFields(type.cardSchema.fields, row.fields, { strict: true })
    }

    const preview = await ProcessDefinitions.preview(ctx, {
      key: published.key,
      version: published.version,
      objectId: documentId,
      variables: input.variables,
      assignees: input.assignees,
    })
    const effective = applyConditions(
      def,
      preview.conditions.filter((item) => item.matched).map((item) => item.index),
    )
    const required = unconditionalSteps(effective)
    const problems: Array<{ path: string; message: string; code: string }> = []
    const people = new Set<string>()
    for (const step of preview.steps) {
      const definition = effective.steps[step.key]
      if (!definition || !required.has(step.key) || !isDecisionStep(definition)) continue
      if (definition.type === 'acknowledge' || definition.type === 'return') continue
      if (step.assignees.length === 0) {
        const name = step.name?.ru ?? step.key
        problems.push({
          path: `steps.${step.key}`,
          message: `Не удалось определить назначенных шага «${name}»`,
          code: 'no_assignees',
        })
      }
      for (const assignee of step.assignees) people.add(assignee.user.id)
    }
    if (problems.length > 0) {
      throw errors.validation(problems[0]?.message ?? 'Проверьте назначенных', problems)
    }
    const denied = await withoutClearance(
      [...people],
      parseConfidentiality(row.confidentiality, 'internal'),
    )
    if (denied.length > 0) {
      throw errors.conflict(
        `Нет допуска к грифу документа: ${await names(denied)} — выберите других участников`,
        { reason: 'clearance', userIds: denied },
      )
    }
    return ProcessService.start(tx, ctx, {
      objectId: documentId,
      definitionKey: published.key,
      variables: input.variables,
      assignees: input.assignees,
    })
  },
}
