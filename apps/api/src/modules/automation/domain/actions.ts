import { createHmac } from 'node:crypto'
import type { LinkKind, RuleAction, TaskStatus } from '@kchs/contracts'
import { resolveAssignees } from '@kchs/process'
import type { EvalScope } from '@kchs/query/expr'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { usersWhoCanView } from '~/kernel/access/explain.js'
import { directory } from '~/kernel/directory/port.js'
import { DiscussionService } from '~/kernel/discussions/service.js'
import { LinkService } from '~/kernel/links/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { objectType } from '~/kernel/objects/registry.js'
import { kernelDirectory } from '~/kernel/process/directory.js'
import { ProcessService } from '~/kernel/process/index.js'
import { processObjectProvider } from '~/kernel/process/registry.js'
import { TagService } from '~/kernel/tags/service.js'
import { AiService } from '~/modules/ai/public.js'
import { CalendarPublic } from '~/modules/calendar/public.js'
import { DocumentsPublic } from '~/modules/documents/public.js'
import { Instructions, Tasks } from '~/modules/tasks/public.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { sendMail } from '~/shared/mail/index.js'
import { type RuleScopeData, renderTemplate, renderValue } from './scope.js'

/**
 * Действия правил (contracts/automation-rule.md §Действия). Каждое выполняется
 * от имени служебного пользователя правила (`run_as`) и проходит те же
 * проверки доступа, что действие человека: правило не может сделать больше,
 * чем `run_as` (ADR-0096). Чужие модули вызываются только через `public.ts`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ActionContext {
  /** Контекст служебного пользователя правила с причиной-событием. */
  ctx: UserCtx
  ruleId: string
  runId: string
  scope: EvalScope
  data: RuleScopeData
  /** Объект события, если он есть. */
  objectId: string | null
  spaceId: string | null
}

export interface ActionOutcome {
  message: string
  objectId?: string | null
  /** Ожидание: правило продолжится через столько минут. */
  waitMinutes?: number
  /** Остановить правило: дальнейшие действия не выполняются. */
  stop?: boolean
}

/** Значение шаблона строкой; пустая строка — ошибка действия. */
function required(value: string, template: string, field: string): string {
  if (value.trim().length === 0) {
    throw errors.validation(`Поле «${field}» шаблона «${template}» пустое`)
  }
  return value
}

function targetId(template: string, context: ActionContext, field = 'object'): string {
  const value = renderValue(template, context.scope)
  const id = typeof value === 'string' ? value.trim() : ''
  if (!UUID.test(id)) {
    throw errors.validation(`Действию нужен объект: «${field}» не дал идентификатора`)
  }
  return id
}

/** Люди по выражениям назначений — тот же язык, что у маршрутов. */
export async function resolvePeople(
  expressions: readonly string[],
  context: ActionContext,
): Promise<string[]> {
  const fields = (context.data.object?.fields as Record<string, unknown>) ?? {}
  const { assignees } = await resolveAssignees(
    expressions.map((expression) => renderTemplate(expression, context.scope)),
    {
      authorId: (context.data.object?.ownerId as string | null) ?? null,
      initiatorId: context.data.actor.id,
      spaceId: context.spaceId,
      variables: {},
      variableTypes: {},
      fields,
    },
    kernelDirectory,
  )
  return assignees.map((item) => item.userId)
}

/** Явные адреса почты из списка получателей (`send_email`). */
function plainEmails(expressions: readonly string[]): string[] {
  return expressions.filter(
    (item) => item.includes('@') && !item.includes('(') && !item.includes(':'),
  )
}

function richBody(text: string): { type: 'doc'; content: Record<string, unknown>[] } {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  }
}

async function objectRow(executor: Executor, id: string) {
  const [row] = await executor
    .select({ id: objects.id, type: objects.type, spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1)
  if (!row) throw errors.notFound('Объект правила')
  return row
}

function objectUrl(id: string, type: string): string {
  return objectType(type)?.route(id) ?? `/o/${id}`
}

/** Один исполнитель: действию нужен конкретный человек. */
async function onePerson(
  expression: string,
  context: ActionContext,
  field: string,
): Promise<string> {
  const [userId] = await resolvePeople([expression], context)
  if (!userId) throw errors.validation(`Выражение «${expression}» (${field}) никого не дало`)
  return userId
}

const AiAnswer = z.object({ text: z.string().max(4000) })

/** Выполняет одно действие правила в своей транзакции. */
export async function runAction(
  action: RuleAction,
  context: ActionContext,
): Promise<ActionOutcome> {
  switch (action.type) {
    case 'wait':
      return { message: `Ожидание ${action.minutes} мин`, waitMinutes: action.minutes }

    case 'stop':
      return { message: 'Правило остановлено', stop: true }

    case 'notify': {
      const objectId = action.object ? targetId(action.object, context) : context.objectId
      const people = await resolvePeople(action.to, context)
      // Уведомление не раскрывает объект: получатели — только те, кто его видит
      const userIds = objectId ? await usersWhoCanView(objectId, people) : people
      if (userIds.length === 0) return { message: 'Получателей нет', objectId }
      const text = required(renderTemplate(action.text, context.scope), action.text, 'text')
      const row = objectId ? await objectRow(db(), objectId) : null
      await NotificationService.notify({
        userIds,
        category: 'system',
        titleKey: 'notifications.tpl.automation',
        params: { text },
        objectId,
        actorId: null,
        url: row ? objectUrl(row.id, row.type) : null,
        aggregateKey: `rule:${context.ruleId}:${objectId ?? 'none'}`,
        channels: action.channels,
      })
      return { message: `Уведомлены: ${userIds.length}`, objectId }
    }

    case 'create_task': {
      const sourceId = targetId(action.source, context, 'source')
      const source = await objectRow(db(), sourceId)
      // Поручение создаётся в пространстве источника: право на создание проверяется
      await authorize(context.ctx, 'view', sourceId)
      const assigneeId = await onePerson(action.assignee, context, 'assignee')
      const coAssigneeIds = await resolvePeople(action.coAssignees, context)
      const controllerId = action.controller
        ? await onePerson(action.controller, context, 'controller')
        : null
      const title = required(renderTemplate(action.title, context.scope), action.title, 'title')
      const description = action.description
        ? renderTemplate(action.description, context.scope)
        : null
      const dueAt = action.dueAt ? renderTemplate(action.dueAt, context.scope) : null
      const created = await db().transaction((tx) =>
        Instructions.create(tx, context.ctx, {
          title,
          ...(description ? { description } : {}),
          source: { kind: 'object', objectId: sourceId },
          assigneeId,
          coAssigneeIds,
          controllerId,
          due: dueAt ? { at: dueAt } : { workingDays: action.dueWorkingDays ?? 3 },
          priority: action.priority as 1 | 2 | 3 | 4 | 5,
          ...(source.spaceId ? { spaceId: source.spaceId } : {}),
        }),
      )
      return { message: `Поручение ${created.key}: ${title}`, objectId: created.id }
    }

    case 'update_fields': {
      const objectId = targetId(action.object, context)
      const row = await objectRow(db(), objectId)
      await authorize(context.ctx, 'edit', objectId)
      const setField = processObjectProvider(row.type)?.setField
      if (!setField) {
        throw errors.validation(`Поля объекта «${row.type}» правило менять не умеет`)
      }
      const changed: string[] = []
      await db().transaction(async (tx) => {
        for (const [key, template] of Object.entries(action.fields)) {
          await setField(tx, context.ctx, objectId, key, renderValue(template, context.scope))
          changed.push(key)
        }
      })
      return { message: `Изменены поля: ${changed.join(', ')}`, objectId }
    }

    case 'set_status': {
      const objectId = targetId(action.object, context)
      const row = await objectRow(db(), objectId)
      const status = renderTemplate(action.status, context.scope)
      if (row.type === 'task') {
        await authorize(context.ctx, 'edit', objectId)
        await db().transaction((tx) =>
          Tasks.setStatus(tx, context.ctx, objectId, status as TaskStatus),
        )
        return { message: `Статус задачи: ${status}`, objectId }
      }
      if (row.type === 'document') {
        await authorize(context.ctx, 'edit', objectId)
        const result = await db().transaction((tx) =>
          DocumentsPublic.applyTransition(tx, context.ctx, objectId, {
            to: status as never,
            cause: 'process',
            source: { kind: 'rule', id: context.ruleId },
          }),
        )
        return { message: `Статус документа: ${result.from} → ${result.to}`, objectId }
      }
      throw errors.validation(`Статус объекта «${row.type}» правило менять не умеет`)
    }

    case 'assign': {
      const objectId = targetId(action.object, context)
      const row = await objectRow(db(), objectId)
      const userId = await onePerson(action.assignee, context, 'assignee')
      if (row.type !== 'task') {
        throw errors.validation(`Назначение для объекта «${row.type}» правило не умеет`)
      }
      await authorize(context.ctx, 'manage', objectId)
      await db().transaction((tx) =>
        action.role === 'controller'
          ? Tasks.setController(tx, context.ctx, objectId, userId)
          : Tasks.reassign(tx, context.ctx, objectId, { assigneeId: userId }),
      )
      const ref = (await directory().refs([userId])).get(userId)
      return { message: `Назначен: ${ref?.displayName ?? userId}`, objectId }
    }

    case 'create_document': {
      const typeId = await DocumentsPublic.typeIdByKey(db(), action.typeKey)
      if (!typeId) throw errors.validation(`Тип документа «${action.typeKey}» не найден`)
      const subject = required(
        renderTemplate(action.subject, context.scope),
        action.subject,
        'subject',
      )
      const fields = Object.fromEntries(
        Object.entries(action.fields).map(([key, template]) => [
          key,
          renderValue(template, context.scope),
        ]),
      )
      const documentId = await db().transaction(async (tx) => {
        const id = await DocumentsPublic.create(tx, context.ctx, {
          typeId,
          subject,
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
        })
        if (action.linkToSource && context.objectId) {
          await LinkService.link(tx, context.ctx, id, context.objectId, 'related')
        }
        return id
      })
      return { message: `Документ: ${subject}`, objectId: documentId }
    }

    case 'start_process': {
      const objectId = targetId(action.object, context)
      await authorize(context.ctx, 'edit', objectId)
      const variables = Object.fromEntries(
        Object.entries(action.variables).map(([key, template]) => [
          key,
          renderValue(template, context.scope),
        ]),
      )
      const { instanceId } = await db().transaction((tx) =>
        ProcessService.start(tx, context.ctx, {
          objectId,
          definitionKey: action.definitionKey,
          variables,
        }),
      )
      return { message: `Маршрут «${action.definitionKey}» запущен`, objectId: instanceId }
    }

    case 'add_link': {
      const objectId = targetId(action.object, context)
      const target = targetId(action.target, context, 'target')
      await authorize(context.ctx, 'edit', objectId)
      await authorize(context.ctx, 'view', target)
      await db().transaction((tx) =>
        LinkService.link(tx, context.ctx, objectId, target, action.kind as LinkKind),
      )
      return { message: 'Связь добавлена', objectId }
    }

    case 'add_tag': {
      const objectId = targetId(action.object, context)
      const tag = required(renderTemplate(action.tag, context.scope), action.tag, 'tag')
      await authorize(context.ctx, 'edit', objectId)
      await db().transaction((tx) => TagService.add(tx, context.ctx, objectId, { name: tag }))
      return { message: `Тег «${tag}»`, objectId }
    }

    case 'post_message': {
      const text = required(renderTemplate(action.text, context.scope), action.text, 'text')
      const target =
        action.conversation === 'object'
          ? null
          : targetId(action.conversation, context, 'conversation')
      const objectId = target ?? context.objectId
      if (!objectId) throw errors.validation('Сообщению нужна беседа или объект события')
      const row = await objectRow(db(), objectId)
      const conversationId = await db().transaction(async (tx) => {
        if (row.type === 'conversation') {
          await authorize(context.ctx, 'post', objectId)
          return objectId
        }
        await authorize(context.ctx, 'comment', objectId)
        return DiscussionService.ensureObjectConversation(tx, context.ctx, objectId)
      })
      await db().transaction((tx) =>
        DiscussionService.post(tx, context.ctx, conversationId, {
          body: richBody(text),
          text,
          attachments: [],
          mentions: [],
          mentionedObjectIds: [],
          idempotencyKey: `rule:${context.runId}:${text.slice(0, 16)}`,
        }),
      )
      return { message: 'Сообщение отправлено', objectId }
    }

    case 'create_event': {
      const title = required(renderTemplate(action.title, context.scope), action.title, 'title')
      const startsAt = required(
        renderTemplate(action.startsAt, context.scope),
        action.startsAt,
        'startsAt',
      )
      const start = Date.parse(startsAt)
      if (Number.isNaN(start)) throw errors.validation(`Начало «${startsAt}» — не дата`)
      const participantIds = await resolvePeople(action.participants, context)
      const eventId = await db().transaction((tx) =>
        CalendarPublic.createEvent(tx, context.ctx, {
          title,
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + action.durationMinutes * 60_000).toISOString(),
          calendarId: action.calendarId,
          participantIds,
        }),
      )
      return { message: `Событие «${title}»`, objectId: eventId }
    }

    case 'send_email': {
      const people = await resolvePeople(action.to, context)
      const rows =
        people.length > 0
          ? await db()
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(eq(users.status, 'active'))
          : []
      const known = new Set(people)
      const addresses = [
        ...rows.filter((row) => known.has(row.id)).map((row) => row.email),
        ...plainEmails(action.to),
      ].filter((address): address is string => Boolean(address))
      if (addresses.length === 0) return { message: 'Адресатов нет' }
      const subject = required(
        renderTemplate(action.subject, context.scope),
        action.subject,
        'subject',
      )
      const body = renderTemplate(action.body, context.scope)
      const sent = await sendMail({
        to: addresses.join(', '),
        subject,
        html: `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
        text: body,
      })
      return { message: sent ? `Письмо: ${addresses.length}` : 'SMTP не настроен' }
    }

    case 'send_telegram': {
      const objectId = action.object ? targetId(action.object, context) : context.objectId
      const people = await resolvePeople(action.to, context)
      const userIds = objectId ? await usersWhoCanView(objectId, people) : people
      if (userIds.length === 0) return { message: 'Получателей нет', objectId }
      const text = required(renderTemplate(action.text, context.scope), action.text, 'text')
      const row = objectId ? await objectRow(db(), objectId) : null
      await NotificationService.notify({
        userIds,
        category: 'system',
        titleKey: 'notifications.tpl.automation',
        params: { text },
        objectId,
        url: row ? objectUrl(row.id, row.type) : null,
        channels: ['telegram'],
        urgent: true,
      })
      return { message: `Telegram: ${userIds.length}`, objectId }
    }

    case 'webhook': {
      const payload = Object.fromEntries(
        Object.entries(action.payload).map(([key, template]) => [
          key,
          renderValue(template, context.scope),
        ]),
      )
      const body = JSON.stringify({ rule: context.ruleId, run: context.runId, ...payload })
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-kchs-rule': context.ruleId,
        'x-kchs-delivery': context.runId,
      }
      for (const [key, template] of Object.entries(action.headers)) {
        headers[key.toLowerCase()] = renderTemplate(template, context.scope)
      }
      if (action.secret) {
        headers['x-kchs-signature'] =
          `sha256=${createHmac('sha256', action.secret).update(body).digest('hex')}`
      }
      const response = await fetch(action.url, {
        method: action.method,
        headers,
        body,
        signal: AbortSignal.timeout(config().KCHS_RULE_WEBHOOK_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw errors.dependencyFailed(`Вызов ${action.url} вернул ${response.status}`)
      }
      return { message: `Вызов ${action.url}: ${response.status}` }
    }

    case 'ai_task': {
      const objectId = targetId(action.object, context)
      const row = await objectRow(db(), objectId)
      await authorize(context.ctx, 'view', objectId)
      const prompt = required(renderTemplate(action.prompt, context.scope), action.prompt, 'prompt')
      const answer = await AiService.complete(
        context.ctx,
        {
          feature: 'automation_rule',
          system: 'Ты помощник корпоративной платформы. Отвечай кратко, по-русски, без вступлений.',
          prompt,
          schema: AiAnswer,
          schemaName: 'AutomationAnswer',
          maxTokens: 800,
          object: { id: row.id, type: row.type },
          details: { ruleId: context.ruleId },
        },
        async (value) => value.text,
      )
      if (action.target.kind === 'comment') {
        const conversationId = await db().transaction((tx) =>
          DiscussionService.ensureObjectConversation(tx, context.ctx, objectId),
        )
        await db().transaction((tx) =>
          DiscussionService.post(tx, context.ctx, conversationId, {
            body: richBody(answer),
            text: answer,
            attachments: [],
            mentions: [],
            mentionedObjectIds: [],
          }),
        )
        return { message: 'Ответ ИИ записан в обсуждение', objectId }
      }
      await authorize(context.ctx, 'edit', objectId)
      const provider = processObjectProvider(row.type)
      const setField = provider?.setField
      if (!setField) {
        throw errors.validation(`Поля объекта «${row.type}» правило менять не умеет`)
      }
      const key = action.target.key
      await db().transaction((tx) => setField(tx, context.ctx, objectId, key, answer))
      return { message: `Ответ ИИ записан в поле ${key}`, objectId }
    }
  }
}

/** Что бы сделало действие: строка для тестового прогона без выполнения. */
export function describeAction(action: RuleAction, scope: EvalScope): string {
  const render = (template: string) => renderTemplate(template, scope)
  switch (action.type) {
    case 'notify':
      return `Уведомить ${action.to.join(', ')}: «${render(action.text)}»`
    case 'create_task':
      return `Поручение «${render(action.title)}» — ${action.assignee}`
    case 'update_fields':
      return `Изменить поля: ${Object.entries(action.fields)
        .map(([key, value]) => `${key} = ${render(value)}`)
        .join(', ')}`
    case 'set_status':
      return `Статус → ${render(action.status)}`
    case 'assign':
      return `Назначить ${action.assignee} (${action.role})`
    case 'create_document':
      return `Документ «${render(action.subject)}» типа ${action.typeKey}`
    case 'start_process':
      return `Запустить маршрут «${action.definitionKey}»`
    case 'add_link':
      return `Связать с ${render(action.target)}`
    case 'add_tag':
      return `Тег «${render(action.tag)}»`
    case 'post_message':
      return `Сообщение: «${render(action.text)}»`
    case 'create_event':
      return `Событие «${render(action.title)}» на ${render(action.startsAt)}`
    case 'send_email':
      return `Письмо ${action.to.join(', ')}: «${render(action.subject)}»`
    case 'send_telegram':
      return `Telegram ${action.to.join(', ')}: «${render(action.text)}»`
    case 'webhook':
      return `Вызов ${action.method} ${action.url}`
    case 'ai_task':
      return `ИИ: «${render(action.prompt)}» → ${action.target.kind}`
    case 'wait':
      return `Ожидание ${action.minutes} мин`
    case 'stop':
      return action.when ? `Остановиться, если ${action.when}` : 'Остановиться'
  }
}
