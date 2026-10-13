import type { DocumentIntakeResult, DocumentStatus } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { ProcessService } from '~/kernel/process/index.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import type { Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { correspondents } from '../../schema.js'
import { CorrespondentService } from '../correspondent-service.js'
import { DocumentService } from '../document-service.js'
import { todayLocal } from '../journal-service.js'
import { DocumentTypeService } from '../type-service.js'
import { DocumentRoutes } from './route-service.js'

/** Статусы после регистрации: приём уже состоялся. */
const REGISTERED: readonly DocumentStatus[] = [
  'registered',
  'on_execution',
  'executed',
  'filed',
  'archived',
]

/**
 * Корреспондент входящего, которое завёл сотрудник Комитета (ADR-0212): его подразделение —
 * «от кого» в журнале, как у донесения территориального органа. Один на подразделение
 * (внешний код `unit:<id>`); без подразделения — сам сотрудник (`user:<id>`). Заводит
 * система: у сотрудника в поле нет права вести справочник корреспондентов.
 */
async function internalCorrespondent(tx: Tx, ctx: UserCtx, unitId: string | null): Promise<string> {
  const externalId = unitId ? `unit:${unitId}` : `user:${ctx.userId}`
  // Два донесения одного подразделения разом не заводят двух корреспондентов
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`correspondent:${externalId}`}))`)
  const [existing] = await tx
    .select({ id: correspondents.id })
    .from(correspondents)
    .where(eq(correspondents.externalId, externalId))
    .limit(1)
  if (existing) return existing.id
  const system = systemCtx('documents.intake', { initiatorId: ctx.userId })
  if (unitId) {
    const unit = (await directory().unitBriefs([unitId])).get(unitId)
    if (unit) {
      return CorrespondentService.create(tx, system, {
        kind: 'organization',
        name: unit.name.ru,
        details: { shortName: unit.code },
        contacts: {},
        externalId,
        mailDomains: [],
      })
    }
  }
  return CorrespondentService.create(tx, system, {
    kind: 'person',
    name: await directory().displayName(ctx.userId),
    details: {},
    contacts: {},
    externalId: `user:${ctx.userId}`,
    mailDomains: [],
  })
}

/**
 * Входящий документ, заведённый сотрудником (донесение из поля, ADR-0212), — на
 * регистрацию маршрутом типа по умолчанию (пакет ЧС: дежурной смене). Повторяемо: очередь
 * устройства шлёт запрос, пока не дойдёт ответ. Реквизиты входящего заполняются сами:
 * корреспондент — подразделение автора, дата поступления — сегодня.
 */
export const DocumentIntake = {
  async send(tx: Tx, ctx: UserCtx, documentId: string): Promise<DocumentIntakeResult> {
    await authorize(ctx, 'edit', documentId)
    // Строка документа заблокирована: повторы из очереди и второй вкладки идут по одному
    const row = await DocumentService.load(tx, documentId, true)
    if (!row) throw errors.notFound('Документ')
    const [running] = await ProcessService.running(tx, documentId)
    if (running) return { state: 'sent', instanceId: running.instanceId }
    const status = row.status as DocumentStatus
    if (REGISTERED.includes(status)) return { state: 'registered', instanceId: null }
    const type = await DocumentTypeService.load(tx, row.typeId)
    if (!type) throw errors.notFound('Тип документа')
    if (type.direction !== 'incoming') {
      throw errors.conflict('На регистрацию так отправляется только входящий документ', {
        reason: 'not_incoming',
      })
    }
    const route = type.defaultRouteKey
      ? (await DocumentRoutes.published(tx)).find((item) => item.key === type.defaultRouteKey)
      : undefined
    // Маршрута приёма нет (пакет ЧС не установлен) — донесение остаётся черновиком автора
    if (!route) return { state: 'draft', instanceId: null }

    const patch = {
      ...(row.correspondentId
        ? {}
        : { correspondentId: await internalCorrespondent(tx, ctx, row.unitId) }),
      ...(row.receivedDate ? {} : { receivedDate: todayLocal() }),
    }
    if (Object.keys(patch).length > 0) await DocumentService.update(tx, ctx, documentId, patch)
    const { instanceId } = await DocumentRoutes.start(tx, ctx, documentId, {
      definitionKey: route.key,
      variables: {},
      assignees: {},
    })
    return { state: 'sent', instanceId }
  },
}
