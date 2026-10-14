import { createHash } from 'node:crypto'
import {
  type CorrespondentKind,
  type CorrespondentRef,
  type DocumentStatus,
  type GovEdmsCheck,
  type GovEdmsCheckInput,
  type GovEdmsDuplicate,
  type GovEdmsIntakeCompleteInput,
  type GovEdmsIntakeCreated,
  type GovEdmsIntakeInput,
  type GovEdmsIntakeList,
  type GovEdmsIntakeListQuery,
  type GovEdmsIntakeRecord,
  GovEdmsPrefill,
  type GovEdmsPrefillStatus,
} from '@kchs/contracts'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { authorize, requireCapability } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { objects } from '~/kernel/objects/schema.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { getObjectStream } from '~/kernel/storage/s3.js'
import { fileSource, fileText } from '~/modules/files/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { decodeCursor, encodeCursor } from '~/shared/http/pagination.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { correspondents, documents, govEdmsIntakes } from '../../schema.js'
import { DOCUMENTS_AUDIT } from '../audit-actions.js'
import { DocumentService } from '../document-service.js'
import { documentsSpaceId } from '../space.js'
import { DocumentTypeService } from '../type-service.js'
import { DocumentVersionService } from '../version-service.js'
import { parseRequisites } from './parse.js'

/**
 * Входящие из госЭДО (ADR-0219). Государственная система закрыта: делопроизводитель
 * выгружает из неё документ (PDF, DOCX, приложения) и заводит его здесь. Порядок —
 * как у обычной регистрации, только быстрее: черновик входящего способом доставки
 * «госЭДО» → файлы загружаются к нему → версия из основного файла и приложений.
 * Повтор того же файла (SHA-256) вторым документом не заводится; номер, дата,
 * отправитель и тема подставляются из текста основного файла, когда движок его
 * извлечёт, — только в пустые поля, правка человека не затирается.
 */

/** Сколько текста основного файла читает разбор: шапка и тема — в начале. */
const PREFILL_TEXT_LIMIT = 20_000
/** Тип входящего по умолчанию — «Входящее письмо» стартового набора. */
const DEFAULT_TYPE_KEY = 'incoming_letter'

type IntakeRow = typeof govEdmsIntakes.$inferSelect

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Тема по имени файла: без расширения и подчёркиваний. */
export function subjectFromFileName(name: string): string {
  const base = name
    .replace(/\.[^.]{1,8}$/, '')
    .replace(/[_]+/g, ' ')
    .trim()
  return (base || name).slice(0, 1000)
}

async function incomingTypeId(executor: Executor, typeId: string | undefined): Promise<string> {
  if (typeId) {
    const type = await DocumentTypeService.load(executor, typeId)
    if (type?.direction !== 'incoming' || !type.isActive) {
      throw errors.validation('Нужен действующий входящий тип документа', [
        { path: 'typeId', message: 'incoming_type' },
      ])
    }
    return type.id
  }
  const preferred = await DocumentTypeService.byKey(executor, DEFAULT_TYPE_KEY)
  if (preferred?.isActive && preferred.direction === 'incoming') return preferred.id
  const first = (await DocumentTypeService.all(executor)).find(
    (type) => type.direction === 'incoming' && type.isActive,
  )
  if (!first) throw errors.conflict('Нет действующего входящего типа документа')
  return first.id
}

/** SHA-256 текущей версии файла — читается из хранилища потоком. */
async function sha256Of(fileId: string): Promise<{ sha256: string; name: string } | null> {
  const source = await fileSource(fileId)
  if (!source) return null
  const { body } = await getObjectStream(source.storageKey, { bucket: source.bucket })
  const hash = createHash('sha256')
  for await (const chunk of body) hash.update(chunk as Buffer)
  return { sha256: hash.digest('hex'), name: source.name }
}

/** Живые документы, заведённые из файла с этим хэшем (кроме самого документа). */
async function documentsBySha(
  executor: Executor,
  hashes: string[],
  except: string | null = null,
): Promise<Array<{ sha256: string; documentId: string }>> {
  if (hashes.length === 0) return []
  const conditions = [inArray(govEdmsIntakes.sha256, hashes), sql`${objects.deletedAt} IS NULL`]
  if (except) conditions.push(ne(govEdmsIntakes.documentId, except))
  const rows = await executor
    .select({ sha256: govEdmsIntakes.sha256, documentId: govEdmsIntakes.documentId })
    .from(govEdmsIntakes)
    .innerJoin(objects, eq(objects.id, govEdmsIntakes.documentId))
    .where(and(...conditions))
  return rows.flatMap((row) =>
    row.sha256 ? [{ sha256: row.sha256, documentId: row.documentId }] : [],
  )
}

async function duplicateBriefs(
  ctx: UserCtx,
  ids: string[],
): Promise<Map<string, GovEdmsDuplicate>> {
  if (ids.length === 0) return new Map()
  const rows = await db()
    .select({
      id: documents.id,
      title: objects.title,
      regNumber: documents.regNumber,
      status: documents.status,
    })
    .from(documents)
    .innerJoin(objects, eq(objects.id, documents.id))
    .where(inArray(documents.id, ids))
  const result = new Map<string, GovEdmsDuplicate>()
  for (const row of rows) {
    // Невидимый смотрящему документ не раскрывает тему — только то, что повтор есть
    const visible = (await authorize(ctx, 'view', row.id, { soft: true })).allowed
    result.set(row.id, {
      id: row.id,
      title: visible ? row.title : '—',
      regNumber: visible ? row.regNumber : null,
      status: row.status as DocumentStatus,
    })
  }
  return result
}

/** Корреспондент, похожий по названию на отправителя из шапки (трехграммы). */
async function matchCorrespondent(name: string): Promise<CorrespondentRef | null> {
  const [row] = await db()
    .select({
      id: correspondents.id,
      kind: correspondents.kind,
      name: correspondents.name,
      score: sql<number>`extensions.similarity(lower(${correspondents.name}), lower(${name}))`,
    })
    .from(correspondents)
    .innerJoin(objects, eq(objects.id, correspondents.id))
    .where(
      and(
        sql`${objects.deletedAt} IS NULL`,
        sql`extensions.similarity(lower(${correspondents.name}), lower(${name})) > 0.3`,
      ),
    )
    .orderBy(sql`extensions.similarity(lower(${correspondents.name}), lower(${name})) desc`)
    .limit(1)
  return row ? { id: row.id, kind: row.kind as CorrespondentKind, name: row.name } : null
}

async function intakeOf(documentId: string): Promise<IntakeRow> {
  const [row] = await db()
    .select()
    .from(govEdmsIntakes)
    .where(eq(govEdmsIntakes.documentId, documentId))
    .limit(1)
  if (!row) throw errors.notFound('Документ из госЭДО')
  return row
}

export const GovEdmsIntake = {
  /** Какие из файлов уже заведены — до загрузки, чтобы не плодить повторы. */
  async check(ctx: UserCtx, input: GovEdmsCheckInput): Promise<GovEdmsCheck> {
    requireCapability(ctx, 'documents.register')
    const found = await documentsBySha(db(), input.sha256)
    const briefs = await duplicateBriefs(ctx, [...new Set(found.map((item) => item.documentId))])
    return {
      matches: found.flatMap((item) => {
        const document = briefs.get(item.documentId)
        return document ? [{ sha256: item.sha256, document }] : []
      }),
    }
  },

  /** Черновик входящего «из госЭДО»: файлы к нему загружаются следом. */
  async create(ctx: UserCtx, input: GovEdmsIntakeInput): Promise<GovEdmsIntakeCreated> {
    requireCapability(ctx, 'documents.register')
    return db().transaction(async (tx) => {
      const typeId = await incomingTypeId(tx, input.typeId)
      const spaceId = await documentsSpaceId(tx)
      const documentId = await DocumentService.create(tx, ctx, {
        typeId,
        subject: input.subject,
        receivedDate: input.receivedDate ?? today(),
        deliveryMethod: 'edms',
      })
      await tx.insert(govEdmsIntakes).values({
        id: newId(),
        documentId,
        createdBy: ctx.userId,
      })
      return { documentId, spaceId }
    })
  },

  /**
   * Файлы загружены: версия из основного файла и приложений. Тот же основной файл уже
   * заведён другим документом — черновик уходит в корзину, ответ называет документ.
   */
  async complete(
    ctx: UserCtx,
    documentId: string,
    input: GovEdmsIntakeCompleteInput,
  ): Promise<GovEdmsIntakeRecord> {
    requireCapability(ctx, 'documents.register')
    const intake = await intakeOf(documentId)
    await authorize(ctx, 'edit', documentId)
    await authorize(ctx, 'view', input.mainFileId)
    const hashed = await sha256Of(input.mainFileId)
    if (!hashed) throw errors.notFound('Основной файл')

    const [duplicate] = await documentsBySha(db(), [hashed.sha256], documentId)
    if (duplicate) {
      await db().transaction((tx) => ObjectService.trash(tx, ctx, documentId))
      const brief = (await duplicateBriefs(ctx, [duplicate.documentId])).get(duplicate.documentId)
      // Ответ об ошибке несёт только текст: номер или тему уже заведённого документа — в нём
      const known = brief?.regNumber ?? (brief && brief.title !== '—' ? `«${brief.title}»` : null)
      throw errors.conflict(
        known
          ? `Этот документ уже заведён из госЭДО: ${known}`
          : 'Этот документ уже заведён из госЭДО',
        { reason: 'gov_edms_duplicate', documentId: duplicate.documentId },
      )
    }

    await db().transaction(async (tx) => {
      await DocumentVersionService.add(tx, ctx, documentId, {
        mainFileId: input.mainFileId,
        attachmentIds: input.attachmentIds.filter((id) => id !== input.mainFileId),
        note: 'Из госЭДО',
      })
      await tx
        .update(govEdmsIntakes)
        .set({ mainFileId: input.mainFileId, fileName: hashed.name, sha256: hashed.sha256 })
        .where(eq(govEdmsIntakes.id, intake.id))
      await publishEvent(tx, ctx, {
        type: 'document.edms_imported',
        object: { id: documentId, type: 'document' },
        payload: {
          intakeId: intake.id,
          mainFileId: input.mainFileId,
          attachments: input.attachmentIds.length,
        },
      })
      await audit(
        ctx,
        {
          action: DOCUMENTS_AUDIT.govEdmsImported,
          objectId: documentId,
          objectType: 'document',
          details: { sha256: hashed.sha256, attachments: input.attachmentIds.length },
        },
        tx,
      )
    })
    // Текст уже мог быть извлечён (тот же файл раньше) — реквизиты сразу
    await GovEdmsIntake.prefill(intake.id).catch((error: unknown) =>
      logger().warn(
        { intakeId: intake.id, error: String(error) },
        'госЭДО: реквизиты не подставлены',
      ),
    )
    const [record] = await records(ctx, [await intakeOf(documentId)])
    if (!record) throw errors.notFound('Документ из госЭДО')
    return record
  },

  /** Текст основного файла извлечён движком — подставить реквизиты ждущих черновиков. */
  async prefillByFile(fileId: string): Promise<void> {
    const rows = await db()
      .select({ id: govEdmsIntakes.id })
      .from(govEdmsIntakes)
      .where(
        and(eq(govEdmsIntakes.mainFileId, fileId), eq(govEdmsIntakes.prefillStatus, 'waiting')),
      )
    for (const row of rows) await GovEdmsIntake.prefill(row.id)
  },

  /**
   * Реквизиты из текста — в пустые поля черновика от имени того, кто его завёл.
   * Нет текста (скан без распознавания) — `none`: заполнит человек.
   */
  async prefill(intakeId: string): Promise<void> {
    const [intake] = await db()
      .select()
      .from(govEdmsIntakes)
      .where(eq(govEdmsIntakes.id, intakeId))
      .limit(1)
    if (!intake?.mainFileId || intake.prefillStatus !== 'waiting') return
    const text = await fileText(intake.mainFileId, PREFILL_TEXT_LIMIT)
    if (text.status === 'queued' || text.status === 'processing') return
    const row = await DocumentService.load(db(), intake.documentId)
    const ctx = intake.createdBy ? await buildUserCtxFor(intake.createdBy) : null
    if (!text.text || !row || !ctx) {
      await db()
        .update(govEdmsIntakes)
        .set({ prefillStatus: 'none' })
        .where(eq(govEdmsIntakes.id, intakeId))
      return
    }
    const parsed = parseRequisites(text.text)
    const correspondent = parsed.sender ? await matchCorrespondent(parsed.sender) : null
    const prefill = GovEdmsPrefill.parse({ ...parsed, correspondent })

    // Только пустые поля черновика: правку человека разбор не затирает
    const patch: Record<string, string> = {}
    if (row.status === 'draft') {
      if (!row.externalNumber && prefill.externalNumber)
        patch.externalNumber = prefill.externalNumber
      if (!row.externalDate && prefill.externalDate) patch.externalDate = prefill.externalDate
      if (!row.correspondentId && correspondent) patch.correspondentId = correspondent.id
      const defaultSubject = intake.fileName ? subjectFromFileName(intake.fileName) : null
      if (prefill.subject && row.subject === defaultSubject) patch.subject = prefill.subject
    }
    const correspondentId = patch.correspondentId ?? row.correspondentId
    const externalNumber = patch.externalNumber ?? row.externalNumber
    const [duplicate] =
      correspondentId && externalNumber
        ? await db()
            .select({ id: documents.id })
            .from(documents)
            .innerJoin(objects, eq(objects.id, documents.id))
            .where(
              and(
                eq(documents.correspondentId, correspondentId),
                eq(documents.externalNumber, externalNumber),
                ne(documents.id, intake.documentId),
                sql`${objects.deletedAt} IS NULL`,
              ),
            )
            .limit(1)
        : []

    await db().transaction(async (tx) => {
      if (Object.keys(patch).length > 0) {
        await DocumentService.update(tx, ctx, intake.documentId, patch)
      }
      await tx
        .update(govEdmsIntakes)
        .set({ prefillStatus: 'done', prefill, duplicateOf: duplicate?.id ?? null })
        .where(eq(govEdmsIntakes.id, intakeId))
      await publishEvent(tx, ctx, {
        type: 'document.edms_prefilled',
        object: { id: intake.documentId, type: 'document' },
        payload: { intakeId, fields: Object.keys(patch), duplicateOf: duplicate?.id ?? null },
      })
    })
  },

  /** Очередь «Из госЭДО»: ещё не зарегистрированные черновики или вся история. */
  async list(ctx: UserCtx, query: GovEdmsIntakeListQuery): Promise<GovEdmsIntakeList> {
    requireCapability(ctx, 'documents.register')
    const conditions = [sql`${objects.deletedAt} IS NULL`]
    if (query.state === 'pending') conditions.push(eq(documents.status, 'draft'))
    const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor)
    if (cursor) {
      conditions.push(
        sql`(${govEdmsIntakes.createdAt}, ${govEdmsIntakes.id}) < (${cursor.createdAt}, ${cursor.id})`,
      )
    }
    const rows = await db()
      .select({ intake: govEdmsIntakes })
      .from(govEdmsIntakes)
      .innerJoin(documents, eq(documents.id, govEdmsIntakes.documentId))
      .innerJoin(objects, eq(objects.id, govEdmsIntakes.documentId))
      .where(and(...conditions))
      .orderBy(desc(govEdmsIntakes.createdAt), desc(govEdmsIntakes.id))
      .limit(query.limit + 1)
    const page = rows.slice(0, query.limit).map((row) => row.intake)
    const last = page[page.length - 1]
    return {
      items: await records(ctx, page),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    }
  },

  /** Черновик завели из госЭДО — для карточки и отчётов («источник: госЭДО»). */
  async isImported(executor: Executor, documentId: string): Promise<boolean> {
    const [row] = await executor
      .select({ id: govEdmsIntakes.id })
      .from(govEdmsIntakes)
      .where(eq(govEdmsIntakes.documentId, documentId))
      .limit(1)
    return Boolean(row)
  },
}

async function records(ctx: UserCtx, rows: IntakeRow[]): Promise<GovEdmsIntakeRecord[]> {
  if (rows.length === 0) return []
  const documentIds = rows.map((row) => row.documentId)
  const docs = await db()
    .select({
      id: documents.id,
      title: objects.title,
      status: documents.status,
      regNumber: documents.regNumber,
      externalNumber: documents.externalNumber,
      externalDate: documents.externalDate,
      correspondentId: documents.correspondentId,
    })
    .from(documents)
    .innerJoin(objects, eq(objects.id, documents.id))
    .where(inArray(documents.id, documentIds))
  const docById = new Map(docs.map((doc) => [doc.id, doc]))
  const correspondentIds = [
    ...new Set(docs.map((doc) => doc.correspondentId).filter((id): id is string => Boolean(id))),
  ]
  const [names, people, duplicates] = await Promise.all([
    correspondentIds.length > 0
      ? db()
          .select({ id: correspondents.id, kind: correspondents.kind, name: correspondents.name })
          .from(correspondents)
          .where(inArray(correspondents.id, correspondentIds))
      : Promise.resolve([]),
    directory().refs([
      ...new Set(rows.map((row) => row.createdBy).filter((id): id is string => Boolean(id))),
    ]),
    duplicateBriefs(ctx, [
      ...new Set(rows.map((row) => row.duplicateOf).filter((id): id is string => Boolean(id))),
    ]),
  ])
  const refById = new Map<string, CorrespondentRef>(
    names.map((row) => [
      row.id,
      { id: row.id, kind: row.kind as CorrespondentKind, name: row.name },
    ]),
  )
  return rows.flatMap((row) => {
    const doc = docById.get(row.documentId)
    if (!doc) return []
    const prefill = row.prefill ? GovEdmsPrefill.safeParse(row.prefill) : null
    return [
      {
        id: row.id,
        document: {
          id: doc.id,
          title: doc.title,
          status: doc.status as DocumentStatus,
          regNumber: doc.regNumber,
          externalNumber: doc.externalNumber,
          externalDate: doc.externalDate,
          correspondent: doc.correspondentId ? (refById.get(doc.correspondentId) ?? null) : null,
        },
        fileName: row.fileName,
        sha256: row.sha256,
        prefillStatus: row.prefillStatus as GovEdmsPrefillStatus,
        prefill: prefill?.success ? prefill.data : null,
        duplicateOf: row.duplicateOf ? (duplicates.get(row.duplicateOf) ?? null) : null,
        createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
        createdAt: row.createdAt,
      },
    ]
  })
}
