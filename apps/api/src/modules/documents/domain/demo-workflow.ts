import { ResolutionInput } from '@kchs/contracts'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { ProcessService, ProcessView } from '~/kernel/process/index.js'
import { deleteObject, putObject } from '~/kernel/storage/s3.js'
import { registerStoredFile } from '~/modules/files/public.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documents, documentTypes, objects, resolutionRequests } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { type DemoDocumentPeople, demoScanPdf } from './demo-documents.js'
import { ResolutionService } from './resolution-service.js'
import { DocumentRoutes } from './routes/route-service.js'
import { documentsSpaceId } from './space.js'
import { DocumentVersionService } from './version-service.js'

export interface DemoWorkflowSummary {
  routes: number
  resolutions: number
  skipped: boolean
}

/** До какой точки довести маршрут исходящего демо-мира. */
type RouteStage = 'started' | 'one_approved' | 'deputy' | 'signing'
const OUTGOING_STAGES: readonly RouteStage[] = ['started', 'one_approved', 'deputy', 'signing']

const RESOLUTIONS = [
  { text: 'Прошу подготовить ответ', days: 5 },
  { text: 'Прошу рассмотреть и доложить', days: 3 },
  { text: 'Прошу подготовить предложения в план мероприятий', days: 10 },
  { text: 'Для исполнения в установленный срок', days: 7 },
  { text: 'Прошу проверить сведения на месте и доложить', days: 5 },
  { text: 'Прошу подготовить проект ответа с учётом данных районов', days: 10 },
] as const

/**
 * Документооборот демо-мира в работе (P3-E05 S02; ADR-0083, ADR-0084): поверх
 * демо-документов — исходящие на разных шагах маршрута «Исходящее письмо»
 * (согласование юриста и отдела, заместитель, подпись), служебные записки на
 * подписи руководителя подразделения, входящие с резолюциями и поручениями по
 * направлениям руководителей. Всё — доменными действиями от имени участников,
 * как в интерфейсе. Повторный запуск ничего не добавляет (метка `demoFlow`).
 */
export async function seedDemoWorkflow(people: DemoDocumentPeople): Promise<DemoWorkflowSummary> {
  const log = logger().child({ module: 'seed.documents' })
  const [already] = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.type, 'document'), isNotNull(sql`${objects.meta}->>'demoFlow'`)))
    .limit(1)
  if (already || people.staff.length < 3) return { routes: 0, resolutions: 0, skipped: true }

  const contexts = new Map<string, UserCtx>()
  const ctxOf = async (userId: string): Promise<UserCtx> => {
    const cached = contexts.get(userId)
    if (cached) return cached
    const ctx = await buildUserCtxFor(userId)
    if (!ctx) throw new Error(`демо-маршруты: нет сотрудника ${userId}`)
    contexts.set(userId, ctx)
    return ctx
  }
  const spaceId = await db().transaction((tx) => documentsSpaceId(tx))
  const batch = newId()
  let files = 0
  const mark = (documentId: string, flow: string) =>
    db().transaction((tx) =>
      ObjectService.update(
        tx,
        systemCtx('seed.documents'),
        documentId,
        { meta: { demoFlow: flow }, mergeMeta: true },
        { silent: true },
      ),
    )

  /** Первая версия черновика: PDF-проект письма от имени автора. */
  const addVersion = async (author: UserCtx, documentId: string) => {
    files += 1
    const sourceKey = `demo/documents/${batch}/draft-${files}.pdf`
    const pdf = demoScanPdf(`Draft #${files}`)
    await putObject(sourceKey, pdf, { contentType: 'application/pdf', contentLength: pdf.length })
    const file = await registerStoredFile(author, {
      spaceId,
      attachToObjectId: documentId,
      name: `Проект ${files}.pdf`,
      mime: 'application/pdf',
      sourceKey,
    })
    await deleteObject(sourceKey)
    await db().transaction((tx) =>
      DocumentVersionService.add(tx, author, documentId, {
        mainFileId: file.id,
        attachmentIds: [],
        note: null,
      }),
    )
  }

  /** Решение всех ждущих текущего шага: «Согласовать» от имени каждого. */
  const approveCurrent = async (documentId: string, only?: string): Promise<boolean> => {
    const [route] = await ProcessView.active(db(), documentId)
    const step = route?.steps[0]
    if (step?.type !== 'approval') return false
    const pending = step.pending.map((user) => user.id).filter((id) => !only || id === only)
    for (const userId of pending) {
      const ctx = await ctxOf(userId)
      await db().transaction((tx) =>
        ProcessService.act(tx, ctx, { stepId: step.id, action: 'approve' }),
      )
    }
    return pending.length > 0
  }

  const drafts = async (typeKey: string) =>
    db()
      .select({ id: documents.id, authorId: documents.authorId })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
      .where(
        and(
          eq(documentTypes.key, typeKey),
          eq(documents.status, 'draft'),
          isNotNull(sql`${objects.meta}->>'demoKey'`),
          sql`${objects.deletedAt} IS NULL`,
        ),
      )
      .orderBy(asc(sql`(${objects.meta}->>'demoKey')`))

  // ── Исходящие: юрист и отдел параллельно → заместитель → подпись ──────────
  let routes = 0
  const staff = people.staff
  const outgoing = (await drafts('outgoing_letter')).slice(0, OUTGOING_STAGES.length)
  for (const [index, draft] of outgoing.entries()) {
    const stage = OUTGOING_STAGES[index] as RouteStage
    if (!draft.authorId) continue
    try {
      const author = await ctxOf(draft.authorId)
      const approvers = staff
        .filter((person) => person.id !== draft.authorId)
        .slice(index * 2, index * 2 + 2)
        .map((person) => person.id)
      if (approvers.length < 2) continue
      await addVersion(author, draft.id)
      await db().transaction((tx) =>
        DocumentRoutes.start(tx, author, draft.id, {
          definitionKey: 'document_outgoing',
          variables: {},
          assignees: { review: approvers },
        }),
      )
      routes += 1
      await mark(draft.id, `route:${stage}`)
      if (stage === 'one_approved') await approveCurrent(draft.id, approvers[0])
      if (stage === 'deputy' || stage === 'signing') await approveCurrent(draft.id)
      if (stage === 'signing') await approveCurrent(draft.id)
    } catch (error) {
      log.warn({ err: error, documentId: draft.id }, 'демо-маршрут исходящего пропущен')
    }
  }

  // ── Служебные записки: подпись руководителя подразделения → регистрация ───
  for (const draft of (await drafts('memo')).slice(0, 2)) {
    if (!draft.authorId) continue
    try {
      const author = await ctxOf(draft.authorId)
      await addVersion(author, draft.id)
      await db().transaction((tx) =>
        DocumentRoutes.start(tx, author, draft.id, {
          definitionKey: 'document_memo',
          variables: {},
          assignees: {},
        }),
      )
      routes += 1
      await mark(draft.id, 'route:signing')
    } catch (error) {
      log.warn({ err: error, documentId: draft.id }, 'демо-маршрут записки пропущен')
    }
  }

  // ── Резолюции по направлениям: руководитель → ответственный и соисполнитель ─
  const waiting = await db()
    .select({ documentId: resolutionRequests.documentId, headId: resolutionRequests.userId })
    .from(resolutionRequests)
    .innerJoin(documents, eq(documents.id, resolutionRequests.documentId))
    .innerJoin(objects, eq(objects.id, documents.id))
    .where(
      and(
        eq(resolutionRequests.state, 'open'),
        eq(documents.status, 'registered'),
        isNotNull(sql`${objects.meta}->>'demoKey'`),
        sql`${objects.deletedAt} IS NULL`,
      ),
    )
    .orderBy(desc(documents.regDate), asc(documents.regNumber))
  const seen = new Set<string>()
  let resolutions = 0
  for (const request of waiting) {
    if (resolutions >= RESOLUTIONS.length) break
    if (seen.has(request.documentId)) continue
    seen.add(request.documentId)
    const template = RESOLUTIONS[resolutions] as (typeof RESOLUTIONS)[number]
    const unitId = people.heads.find((head) => head.id === request.headId)?.unitId ?? null
    const team = staff.filter((person) => person.unitId !== null && person.unitId === unitId)
    const pool = team.length >= 2 ? team : staff
    const offset = resolutions % pool.length
    const responsible = pool[offset]
    const coExecutor = pool[(offset + 1) % pool.length]
    if (!responsible || !coExecutor || responsible.id === coExecutor.id) continue
    try {
      const head = await ctxOf(request.headId)
      await db().transaction((tx) =>
        ResolutionService.create(
          tx,
          head,
          request.documentId,
          ResolutionInput.parse({
            text: template.text,
            responsibleId: responsible.id,
            coExecutorIds: resolutions % 2 === 0 ? [coExecutor.id] : [],
            dueWorkingDays: template.days,
          }),
        ),
      )
      resolutions += 1
      await mark(request.documentId, 'resolution')
    } catch (error) {
      log.warn({ err: error, documentId: request.documentId }, 'демо-резолюция пропущена')
    }
  }

  log.info({ routes, resolutions }, 'демо-маршруты и резолюции созданы')
  return { routes, resolutions, skipped: false }
}
