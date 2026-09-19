import {
  DocumentCardSchema,
  type DocumentStatus,
  type DocumentUpdateInput,
  parseConfidentiality,
} from '@kchs/contracts'
import type { ProcessFieldHint } from '@kchs/process'
import { and, eq, or } from 'drizzle-orm'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import {
  type ProcessInstanceInfo,
  type ProcessStepInfo,
  registerProcessObjectProvider,
  registerProcessStepHandler,
  registerProcessWaitEvent,
} from '~/kernel/process/index.js'
import { actorId, type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  documentStepVersions,
  documents,
  documentTypes,
  documentVersions,
  journals,
  objects,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { DocumentService } from '../document-service.js'
import { DocumentTypeService } from '../type-service.js'
import { DOCUMENT_OBJECT_TYPE, DocumentRoutes, withoutClearance } from './route-service.js'
import { DocumentSignatures } from './signatures.js'
import { currentStatus, ensureRouteStatus } from './status.js'

/** Исходы маршрута, после которых документ возвращается автору. */
const NEGATIVE = new Set(['rejected', 'refused', 'withdrawn', 'cancelled', 'timeout'])

/** Требования карточки, которые маршрут может поменять шагом `set`. */
const SETTABLE: Record<string, keyof DocumentUpdateInput> = {
  responsible: 'responsibleId',
  signer: 'signerId',
  controller: 'controllerId',
  deadline: 'deadline',
  control: 'control',
  summary: 'summary',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Данные документа для назначений и условий (ADR-0083): реквизиты — полями
 * (`field:signer`, `object.fields.amount`), тип и направление — свойствами
 * (`object.typeKey = 'order'`). Корзину строка не фильтрует: маршрут
 * удалённого документа отменяется, и данные нужны для отмены.
 */
async function load(executor: Executor, documentId: string) {
  const [row] = await executor
    .select({
      typeId: documents.typeId,
      status: documents.status,
      subject: documents.subject,
      regNumber: documents.regNumber,
      fields: documents.fields,
      authorId: documents.authorId,
      responsibleId: documents.responsibleId,
      signerId: documents.signerId,
      controllerId: documents.controllerId,
      correspondentId: documents.correspondentId,
      deadline: documents.deadline,
      unitId: documents.unitId,
      confidentiality: documents.confidentiality,
      spaceId: objects.spaceId,
      title: objects.title,
    })
    .from(documents)
    .innerJoin(objects, eq(objects.id, documents.id))
    .where(eq(documents.id, documentId))
    .limit(1)
  if (!row) return null
  const type = await DocumentTypeService.load(executor, row.typeId)
  return {
    authorId: row.authorId,
    ...(row.unitId ? { authorUnitId: row.unitId } : {}),
    spaceId: row.spaceId,
    title: row.title,
    fields: {
      ...row.fields,
      subject: row.subject,
      author: row.authorId,
      responsible: row.responsibleId,
      signer: row.signerId,
      controller: row.controllerId,
      correspondent: row.correspondentId,
      deadline: row.deadline,
      unit: row.unitId,
    },
    props: {
      typeKey: type?.key ?? null,
      direction: type?.direction ?? null,
      status: row.status,
      regNumber: row.regNumber,
      confidentiality: row.confidentiality,
    },
  }
}

/** Реквизиты документа для конструктора маршрутов: люди — для `field:`, прочее — для условий. */
const REQUISITE_HINTS: ProcessFieldHint[] = [
  { path: 'subject', label: { ru: 'Тема', en: 'Subject' }, type: 'text' },
  { path: 'author', label: { ru: 'Автор', en: 'Author' }, type: 'user' },
  {
    path: 'responsible',
    label: { ru: 'Ответственный', en: 'Responsible' },
    type: 'user',
  },
  { path: 'signer', label: { ru: 'Подписант', en: 'Signer' }, type: 'user' },
  {
    path: 'controller',
    label: { ru: 'Контролёр', en: 'Controller' },
    type: 'user',
  },
  {
    path: 'correspondent',
    label: { ru: 'Корреспондент', en: 'Correspondent' },
    type: 'reference',
  },
  { path: 'deadline', label: { ru: 'Срок', en: 'Deadline' }, type: 'date' },
  { path: 'unit', label: { ru: 'Подразделение', en: 'Unit' }, type: 'unit' },
]

/**
 * Поля для конструктора маршрутов (ADR-0087): реквизиты и поля карточек всех
 * активных типов — ключ встречается в нескольких типах одной подписью.
 */
async function fieldHints(executor: Executor): Promise<ProcessFieldHint[]> {
  const rows = await executor
    .select({ cardSchema: documentTypes.cardSchema })
    .from(documentTypes)
    .where(eq(documentTypes.isActive, true))
  const hints = new Map(REQUISITE_HINTS.map((hint) => [hint.path, hint]))
  for (const row of rows) {
    const parsed = DocumentCardSchema.safeParse(row.cardSchema)
    if (!parsed.success) continue
    for (const field of parsed.data.fields) {
      if (hints.has(field.key)) continue
      hints.set(field.key, { path: field.key, label: field.label, type: field.type })
    }
  }
  return [...hints.values()]
}

/** Заморозка: текущая версия уходит шагу согласования или подписи окончательной. */
async function freeze(tx: Executor, documentId: string, stepId: string): Promise<void> {
  const [row] = await tx
    .select({ versionId: documents.currentVersionId })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
  if (!row?.versionId) return
  await tx
    .update(documentVersions)
    .set({ isFinal: true })
    .where(eq(documentVersions.id, row.versionId))
  await tx
    .insert(documentStepVersions)
    .values({ stepId, documentId, versionId: row.versionId })
    .onConflictDoNothing()
}

/**
 * Назначенные шага должны видеть документ: у кого нет допуска к его грифу,
 * тот решал бы вслепую — шаг не активируется (ADR-0083).
 */
async function assertCleared(tx: Executor, documentId: string, step: ProcessStepInfo) {
  if (step.assignees.length === 0) return
  const [row] = await tx
    .select({ confidentiality: documents.confidentiality })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
  const denied = await withoutClearance(
    step.assignees,
    parseConfidentiality(row?.confidentiality, 'internal'),
  )
  if (denied.length === 0) return
  const refs = await directory().refs(denied)
  throw errors.conflict(
    `Нет допуска к грифу документа: ${denied.map((id) => refs.get(id)?.displayName ?? '—').join(', ')}`,
    { reason: 'clearance', userIds: denied },
  )
}

async function onStepActivated(
  tx: Executor,
  ctx: Ctx,
  { instance, step }: { instance: ProcessInstanceInfo; step: ProcessStepInfo },
): Promise<void> {
  const documentId = instance.objectId
  switch (step.type) {
    case 'approval':
      await assertCleared(tx, documentId, step)
      await ensureRouteStatus(tx, ctx, documentId, 'on_approval', instance.id)
      await freeze(tx, documentId, step.id)
      return
    case 'sign':
      await assertCleared(tx, documentId, step)
      await ensureRouteStatus(tx, ctx, documentId, 'on_signing', instance.id)
      await freeze(tx, documentId, step.id)
      return
    case 'register':
    case 'acknowledge':
      await assertCleared(tx, documentId, step)
      return
    case 'return':
      await ensureRouteStatus(tx, ctx, documentId, 'returned', instance.id)
      return
    default:
      return
  }
}

/** Решение «Подписать» — запись подписи; последняя подпись — статус «Подписан». */
async function onDecision(
  tx: Executor,
  ctx: Ctx,
  {
    instance,
    step,
    decision,
  }: {
    instance: ProcessInstanceInfo
    step: ProcessStepInfo
    decision: { userId: string; actorId: string; action: string }
  },
): Promise<void> {
  const definition = step.definition
  if (definition.type !== 'sign' || decision.action !== 'sign') return
  const signature = await DocumentSignatures.record(tx, ctx, {
    documentId: instance.objectId,
    stepId: step.id,
    signerId: decision.userId,
    actorId: decision.actorId,
    mfa: definition.requireMfa,
    kind: 'simple',
  })
  const [object] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, instance.objectId))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'document.signed',
    object: {
      id: instance.objectId,
      type: DOCUMENT_OBJECT_TYPE,
      spaceId: object?.spaceId ?? null,
      title: object?.title ?? null,
    },
    payload: {
      signatureId: signature.id,
      versionId: signature.versionId,
      signerId: decision.userId,
      stepId: step.id,
      hash: signature.hash,
      mfa: definition.requireMfa,
    },
  })
  // Все подписали — до шага регистрации в том же переходе документ уже «Подписан»
  if (step.outcome === 'signed') {
    await ensureRouteStatus(tx, ctx, instance.objectId, 'signed', instance.id)
  }
}

async function onStepCompleted(
  tx: Executor,
  ctx: Ctx,
  { instance, step }: { instance: ProcessInstanceInfo; step: ProcessStepInfo },
): Promise<void> {
  if (step.type === 'sign' && step.outcome === 'signed') {
    await ensureRouteStatus(tx, ctx, instance.objectId, 'signed', instance.id)
  }
}

/**
 * Маршрут завершён: одобрен без подписи — «Согласован»; отклонён, отозван,
 * отменён — «Возвращён» (из согласования или подписи). Документ, ушедший
 * дальше (подписан, зарегистрирован), не трогается.
 */
async function onFinished(
  tx: Executor,
  ctx: Ctx,
  {
    instance,
    status,
    outcome,
  }: { instance: ProcessInstanceInfo; status: 'finished' | 'cancelled'; outcome: string },
): Promise<void> {
  const current: DocumentStatus = await currentStatus(tx, instance.objectId)
  if (current !== 'on_approval' && current !== 'on_signing') return
  const success = status === 'finished' && !NEGATIVE.has(outcome)
  await ensureRouteStatus(
    tx,
    ctx,
    instance.objectId,
    success && current === 'on_approval' ? 'approved' : 'returned',
    instance.id,
  )
}

/** Журнал шага `register`: идентификатор, префикс или название; без него — журнал типа. */
async function journalOf(executor: Executor, value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim()) return null
  const key = value.trim()
  const [row] = await executor
    .select({ id: journals.id })
    .from(journals)
    .where(
      UUID.test(key) ? eq(journals.id, key) : or(eq(journals.prefix, key), eq(journals.name, key)),
    )
    .limit(1)
  if (!row) throw errors.conflict(`Журнал «${key}» из маршрута не найден`, { reason: 'journal' })
  return row.id
}

/**
 * Маршруты документов на движке процессов (ADR-0083): поставщик данных
 * `document` с хуками статусов и заморозки версии, исполнитель шага
 * `register`, события для шагов `wait`. Регистрируется в любой роли процесса.
 */
export function registerDocumentProcess(): void {
  registerProcessObjectProvider({
    objectType: DOCUMENT_OBJECT_TYPE,
    load,
    fieldHints,
    setField: async (tx, ctx, documentId, field, value) => {
      const path = field.startsWith('fields.') ? field.slice('fields.'.length) : field
      const requisite = SETTABLE[path]
      const patch: DocumentUpdateInput = requisite
        ? ({ [requisite]: value } as DocumentUpdateInput)
        : { fields: { [path]: value } }
      // Шаг маршрута правит карточку от имени системы: права проверил тот, кто запустил
      await DocumentService.update(
        tx,
        systemCtx('documents.route.set', { initiatorId: actorId(ctx) }),
        documentId,
        patch,
      )
    },
    canStart: async (ctx, documentId) => {
      await DocumentRoutes.assertCanStart(db(), ctx, documentId)
    },
    onStepActivated,
    onDecision,
    onStepCompleted,
    onFinished,
  })

  registerProcessStepHandler({
    type: 'register',
    objectType: DOCUMENT_OBJECT_TYPE,
    execute: async (tx, ctx, { instance, params, actor }) => {
      const documentId = instance.objectId
      const journalId = await journalOf(tx, params.journal)
      // Подпись завершена в этом же переходе (например, переназначением) — «Подписан»
      if ((await currentStatus(tx, documentId)) === 'on_signing') {
        await ensureRouteStatus(tx, ctx, documentId, 'signed', instance.id)
      }
      // Регистрирует назначенный делопроизводитель, без назначенных — система по маршруту
      const registrar =
        actor && ctx.kind === 'user'
          ? ctx
          : systemCtx('documents.route.register', { initiatorId: actorId(ctx) })
      const number = await DocumentService.register(
        tx,
        registrar,
        documentId,
        journalId ? { journalId } : {},
        { viaRoute: true },
      )
      return { outcome: 'registered', result: { number } }
    },
  })

  // Маршрут может ждать новой версии, подписи или регистрации документа
  for (const type of ['document.version_added', 'document.signed', 'document.registered']) {
    registerProcessWaitEvent(type)
  }
}

/** Шаги маршрута, отданные версии: какая версия была у согласования и подписи. */
export async function stepVersions(
  executor: Executor,
  documentId: string,
): Promise<Map<string, { versionId: string; number: number }>> {
  const rows = await executor
    .select({
      stepId: documentStepVersions.stepId,
      versionId: documentStepVersions.versionId,
      number: documentVersions.number,
    })
    .from(documentStepVersions)
    .innerJoin(documentVersions, eq(documentVersions.id, documentStepVersions.versionId))
    .where(
      and(
        eq(documentStepVersions.documentId, documentId),
        eq(documentVersions.documentId, documentId),
      ),
    )
  return new Map(rows.map((row) => [row.stepId, { versionId: row.versionId, number: row.number }]))
}
