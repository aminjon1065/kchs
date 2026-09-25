import {
  type CorrespondentKind,
  type CorrespondentRef,
  type DocumentStatus,
  isPublicMailDomain,
  MAIL_PURGED_STATUSES,
  MAIL_QUEUE_RETENTION_DAYS,
  type MailAttachmentRef,
  type MailboxConfig,
  type MailCorrespondentMatch,
  type MailMessageList,
  type MailMessageListQuery,
  type MailMessageRecord,
  type MailMessageStatus,
  type MailPollReport,
  type MailPollResult,
} from '@kchs/contracts'
import { and, arrayOverlaps, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { authorize, loadObject, requireCapability } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { deleteObject, putObject } from '~/kernel/storage/s3.js'
import {
  fileBriefs,
  fileBuckets,
  fileStorageKey,
  registerGeneratedFile,
} from '~/modules/files/public.js'
import { Integrations } from '~/modules/integrations/public.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { correspondents, documents, mailMessages, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { decodeCursor, encodeCursor } from '~/shared/http/pagination.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { type FetchedLetter, mailboxPort, readMailbox } from '~/shared/mail/imap.js'
import { DocumentService } from '../document-service.js'
import { documentsSpaceId } from '../space.js'
import { DocumentTypeService } from '../type-service.js'
import { DocumentVersionService } from '../version-service.js'
import {
  letterRejection,
  messageKeyOf,
  type ParsedLetter,
  parseLetter,
  subjectOf,
} from './parse.js'

/**
 * Регистрация входящих из почтового ящика канцелярии (08-documents.md §5,
 * 14-automation-integrations.md §5, ADR-0113).
 *
 * Письмо объектом реестра не становится: им становится черновик входящего,
 * заведённый из письма, а вложения — его файлами. Строка `mail_messages` —
 * запись очереди «Из почты»: что пришло, во что превратилось и почему не
 * превратилось. Ящик описывает интеграция `imap` (ADR-0097): конфигурация,
 * зашифрованный пароль, «Проверить соединение» и журнал синхронизаций.
 */

type Outcome = 'created' | 'duplicates' | 'skipped' | 'failed'

const DAY_MS = 86_400_000

const EMPTY: MailPollResult = { fetched: 0, created: 0, duplicates: 0, skipped: 0, failed: 0 }

/** Ящик, готовый к опросу: разобранная конфигурация и пароль. */
interface Mailbox {
  integrationId: string
  key: string
  kind: string
  config: MailboxConfig
  password: string
}

export const MailIntake = {
  /**
   * Проход по ящикам. Вызывается расписанием (единый планировщик проверяет раз
   * в пять минут, ADR-0096) и кнопкой «Получить почту». Ящик опрашивается,
   * если с прошлого раза прошло не меньше его `pollMinutes`; `force` снимает
   * это условие для ручного запуска.
   */
  async poll(options: { force?: boolean; integrationId?: string } = {}): Promise<MailPollReport> {
    const rows = await Integrations.enabledOfKind('imap')
    const failures: Array<{ integrationId: string; message: string }> = []
    let total = EMPTY
    let mailboxes = 0

    for (const row of rows) {
      if (options.integrationId && row.id !== options.integrationId) continue
      const read = readMailbox(row.config, row.secrets)
      if ('error' in read) {
        failures.push({ integrationId: row.id, message: read.error })
        await recordSync(row, 'error', read.error, {})
        continue
      }
      if (!options.force && !dueNow(row.lastSyncAt, read.config.pollMinutes)) continue

      mailboxes += 1
      const mailbox: Mailbox = {
        integrationId: row.id,
        key: row.key,
        kind: row.kind,
        config: read.config,
        password: read.password,
      }
      try {
        const result = await MailIntake.pollMailbox(mailbox)
        total = merge(total, result)
        await recordSync(row, 'ok', null, { ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'ошибка опроса ящика'
        failures.push({ integrationId: row.id, message })
        await recordSync(row, 'error', message, {})
        logger().warn({ integration: row.key, error: message }, 'IMAP: опрос ящика не удался')
      }
    }

    return { mailboxes, result: total, errors: failures }
  },

  /** Один ящик: забрать письма, завести черновики, пометить разобранное. */
  async pollMailbox(mailbox: Mailbox): Promise<MailPollResult> {
    const letters = await mailboxPort().fetch(
      mailbox.config,
      mailbox.password,
      mailbox.config.batchSize,
    )
    let result: MailPollResult = { ...EMPTY, fetched: letters.length }
    const handled: number[] = []

    for (const letter of letters) {
      const outcome = await MailIntake.ingest(mailbox, letter)
      result = { ...result, [outcome]: result[outcome] + 1 }
      // Неразобранное письмо остаётся непрочитанным: человек увидит его в
      // ящике и разберётся сам. Всё остальное — разобрано, помечаем
      if (outcome !== 'failed') handled.push(letter.uid)
    }

    if (mailbox.config.markSeen && handled.length > 0) {
      await mailboxPort()
        .markSeen(mailbox.config, mailbox.password, handled)
        .catch((error: unknown) => {
          logger().warn(
            { integration: mailbox.key, error: String(error) },
            'IMAP: письма не помечены прочитанными',
          )
        })
    }
    return result
  },

  /**
   * Одно письмо. Порядок важен: сначала дедупликация, потом правила отбора и
   * только потом работа с хранилищем — чтобы повтор не заводил ни второго
   * документа, ни лишних байтов.
   */
  async ingest(mailbox: Mailbox, fetched: FetchedLetter): Promise<Outcome> {
    let letter: ParsedLetter
    let messageKey = `uid:${fetched.uidValidity ?? '0'}:${fetched.uid}`
    try {
      letter = await parseLetter(fetched.source)
      messageKey = messageKeyOf(letter, fetched)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'письмо не разобралось'
      await recordFailure(mailbox, fetched, messageKey, message)
      return 'failed'
    }

    if (await seen(mailbox.integrationId, messageKey)) return 'duplicates'

    const rejection = letterRejection(letter, mailbox.config.filters)
    if (rejection) {
      await db()
        .insert(mailMessages)
        .values({
          id: newId(),
          integrationId: mailbox.integrationId,
          messageKey,
          uid: fetched.uid,
          uidValidity: fetched.uidValidity,
          fromEmail: letter.fromEmail,
          fromName: letter.fromName,
          toEmail: letter.toEmail,
          subject: letter.subject,
          body: letter.body,
          headers: headersOf(letter),
          sentAt: letter.sentAt,
          status: 'rejected',
          rejectReason: rejection,
        })
        .onConflictDoNothing()
      return 'skipped'
    }

    try {
      await createDraft(mailbox, fetched, letter, messageKey)
      return 'created'
    } catch (error) {
      const message = error instanceof Error ? error.message : 'черновик не создан'
      await recordFailure(mailbox, fetched, messageKey, message)
      logger().warn({ integration: mailbox.key, error: message }, 'почта: черновик не создан')
      return 'failed'
    }
  },

  async list(ctx: UserCtx, query: MailMessageListQuery): Promise<MailMessageList> {
    requireCapability(ctx, 'documents.register')
    const conditions = [sql`true`]
    if (query.status) conditions.push(eq(mailMessages.status, query.status))
    if (query.integrationId) conditions.push(eq(mailMessages.integrationId, query.integrationId))
    if (query.q?.trim()) {
      const pattern = `%${query.q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      const match = or(
        ilike(mailMessages.subject, pattern),
        ilike(mailMessages.fromEmail, pattern),
        ilike(mailMessages.fromName, pattern),
      )
      if (match) conditions.push(match)
    }
    const cursor = decodeCursor<{ receivedAt: string; id: string }>(query.cursor)
    if (cursor) {
      conditions.push(
        sql`(${mailMessages.receivedAt}, ${mailMessages.id}) < (${cursor.receivedAt}, ${cursor.id})`,
      )
    }

    const [rows, pendingRow] = await Promise.all([
      db()
        .select()
        .from(mailMessages)
        .where(and(...conditions))
        .orderBy(desc(mailMessages.receivedAt), desc(mailMessages.id))
        .limit(query.limit + 1),
      db()
        .select({ total: count() })
        .from(mailMessages)
        .where(eq(mailMessages.status, 'draft'))
        .then((result) => result[0]),
    ])

    const page = rows.slice(0, query.limit)
    const last = page[page.length - 1]
    return {
      items: await records(page),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ receivedAt: last.receivedAt, id: last.id })
          : null,
      pending: pendingRow?.total ?? 0,
    }
  },

  async get(ctx: UserCtx, id: string): Promise<MailMessageRecord> {
    requireCapability(ctx, 'documents.register')
    const [row] = await db().select().from(mailMessages).where(eq(mailMessages.id, id)).limit(1)
    if (!row) throw errors.notFound('Письмо')
    const [record] = await records([row])
    if (!record) throw errors.notFound('Письмо')
    return record
  },

  /**
   * Отклонение с причиной: документа не будет, черновик уходит в корзину, а
   * письмо остаётся в очереди с отметкой — второй раз оно не зарегистрируется.
   */
  async reject(ctx: UserCtx, id: string, reason: string): Promise<MailMessageRecord> {
    requireCapability(ctx, 'documents.register')
    const [row] = await db().select().from(mailMessages).where(eq(mailMessages.id, id)).limit(1)
    if (!row) throw errors.notFound('Письмо')
    if (row.status === 'registered') {
      throw errors.conflict('Письмо уже зарегистрировано документом')
    }
    // Черновик удаляет тот, кто отклоняет: право на удаление проверит ядро.
    // Повторное отклонение (правка причины) черновика уже не застаёт
    const draft = row.documentId ? await aliveDocument(row.documentId) : null
    if (draft) await authorize(ctx, 'delete', draft)

    await db().transaction(async (tx) => {
      await tx
        .update(mailMessages)
        .set({
          status: 'rejected',
          rejectReason: reason,
          decidedBy: ctx.userId,
          decidedAt: sql`now()`,
        })
        .where(eq(mailMessages.id, id))
      if (draft) await ObjectService.trash(tx, ctx, draft.id)
      await publishEvent(tx, ctx, {
        type: 'mail.rejected',
        ...(row.documentId ? { object: { id: row.documentId, type: 'document' } } : {}),
        payload: { messageId: id, reason },
      })
    })

    await audit(ctx, {
      action: AUDIT_ACTIONS.mailRejected,
      objectId: row.documentId,
      objectType: 'document',
      details: { messageKey: row.messageKey, from: row.fromEmail, reason },
    })
    return MailIntake.get(ctx, id)
  },

  /**
   * Срок хранения очереди (ADR-0136): отклонённые и неразобранные письма удаляются через
   * 180 дней после решения, а без решения — после получения. Черновики и зарегистрированные
   * остаются: по ним видно, из какого письма заведён документ. Файлы писем здесь не живут —
   * вложения принадлежат черновику и уходят с ним по правилам корзины. Вызывается заданием
   * обслуживания раз в сутки.
   */
  async purge(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - MAIL_QUEUE_RETENTION_DAYS * DAY_MS).toISOString()
    const ctx = systemCtx('documents.mail-purge')
    return db().transaction(async (tx) => {
      const removed = await tx
        .delete(mailMessages)
        .where(
          and(
            inArray(mailMessages.status, [...MAIL_PURGED_STATUSES]),
            sql`coalesce(${mailMessages.decidedAt}, ${mailMessages.receivedAt}) < ${before}`,
          ),
        )
        .returning({ id: mailMessages.id })
      if (removed.length > 0) {
        await publishEvent(tx, ctx, {
          type: 'mail.purged',
          payload: { count: removed.length, before },
        })
      }
      return removed.length
    })
  },

  /**
   * Документ зарегистрирован — письмо уходит из очереди. Вызывается
   * подписчиком события `document.registered`: очередь не гадает о состоянии
   * документа, а узнаёт о нём из события (CLAUDE.md, правило 3).
   */
  async markRegistered(tx: Executor, documentId: string): Promise<void> {
    await tx
      .update(mailMessages)
      .set({ status: 'registered', decidedAt: sql`now()` })
      .where(and(eq(mailMessages.documentId, documentId), eq(mailMessages.status, 'draft')))
  },
}

function merge(a: MailPollResult, b: MailPollResult): MailPollResult {
  return {
    fetched: a.fetched + b.fetched,
    created: a.created + b.created,
    duplicates: a.duplicates + b.duplicates,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
  }
}

/** Пора ли опрашивать ящик: с прошлой синхронизации прошло `pollMinutes`. */
function dueNow(lastSyncAt: string | null, pollMinutes: number): boolean {
  if (!lastSyncAt) return true
  return Date.now() - new Date(lastSyncAt).getTime() >= pollMinutes * 60_000
}

async function seen(integrationId: string, messageKey: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(eq(mailMessages.integrationId, integrationId), eq(mailMessages.messageKey, messageKey)),
    )
    .limit(1)
  return Boolean(row)
}

function headersOf(letter: ParsedLetter): Record<string, unknown> {
  return {
    messageId: letter.messageId,
    ...(letter.inReplyTo ? { inReplyTo: letter.inReplyTo } : {}),
    ...(letter.references.length > 0 ? { references: letter.references.slice(0, 20) } : {}),
  }
}

/** Письмо не разобралось: оно помечается в очереди, а не теряется. */
async function recordFailure(
  mailbox: Mailbox,
  fetched: FetchedLetter,
  messageKey: string,
  message: string,
): Promise<void> {
  const ctx = systemCtx('documents.mail')
  const error = message.slice(0, 2000)
  await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(mailMessages)
      .values({
        id: newId(),
        integrationId: mailbox.integrationId,
        messageKey,
        uid: fetched.uid,
        uidValidity: fetched.uidValidity,
        status: 'failed',
        error,
      })
      .onConflictDoUpdate({
        target: [mailMessages.integrationId, mailMessages.messageKey],
        set: { status: 'failed', error },
      })
      .returning({ id: mailMessages.id })
    if (!row) return
    await publishEvent(tx, ctx, {
      type: 'mail.failed',
      payload: { messageId: row.id, error: error.slice(0, 500) },
    })
  })
}

async function recordSync(
  row: { id: string; key: string; kind: string },
  status: 'ok' | 'error',
  message: string | null,
  stats: Record<string, unknown>,
): Promise<void> {
  const ctx = systemCtx('documents.mail')
  await db().transaction((tx) =>
    Integrations.recordSync(tx, ctx, {
      integrationId: row.id,
      key: row.key,
      kind: row.kind,
      status,
      message,
      stats,
    }),
  )
}

/**
 * Черновик входящего из письма. Права — того сотрудника канцелярии, которого
 * назвала интеграция (`runAsUserId`): документ заводится его руками, и всё
 * дальнейшее проходит обычный `authorize` (тот же приём, что у правил
 * автоматизации, ADR-0096).
 */
async function createDraft(
  mailbox: Mailbox,
  fetched: FetchedLetter,
  letter: ParsedLetter,
  messageKey: string,
): Promise<void> {
  const ctx = await buildUserCtxFor(mailbox.config.runAsUserId)
  if (!ctx) throw new Error('служебный пользователь ящика не найден или заблокирован')
  requireCapability(ctx, 'documents.register')

  const type = await DocumentTypeService.byKey(db(), mailbox.config.documentTypeKey)
  if (!type) throw new Error(`нет типа документа «${mailbox.config.documentTypeKey}»`)
  const spaceId = await documentsSpaceId(db())
  const match = await matchCorrespondent(letter.fromEmail)
  const correspondentId = match?.id ?? null

  // Вложения кладутся в хранилище до транзакции: их байты не должны держать
  // её открытой. Идентификаторы выданы заранее — они же в ключе хранения
  const planned = letter.attachments.map((attachment) => {
    const fileId = newId()
    const versionId = newId()
    return {
      ...attachment,
      fileId,
      versionId,
      storageKey: fileStorageKey(spaceId, fileId, versionId, attachment.name),
    }
  })
  for (const attachment of planned) {
    await putObject(attachment.storageKey, attachment.content, {
      bucket: fileBuckets.files(),
      contentType: attachment.mime,
    })
  }

  let created: string | null = null
  try {
    created = await db().transaction(async (tx) => {
      const documentId = await DocumentService.create(tx, ctx, {
        typeId: type.id,
        subject: subjectOf(letter),
        summary: letter.body || null,
        correspondentId,
        receivedDate: new Date().toISOString().slice(0, 10),
        deliveryMethod: 'email',
        ...(letter.sentAt ? { externalDate: letter.sentAt.slice(0, 10) } : {}),
      })

      for (const attachment of planned) {
        await registerGeneratedFile(tx, ctx, {
          fileId: attachment.fileId,
          versionId: attachment.versionId,
          spaceId,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.content.byteLength,
          storageKey: attachment.storageKey,
          checksum: null,
          attachToObjectId: documentId,
        })
      }
      const [row] = await tx
        .insert(mailMessages)
        .values({
          id: newId(),
          integrationId: mailbox.integrationId,
          messageKey,
          uid: fetched.uid,
          uidValidity: fetched.uidValidity,
          fromEmail: letter.fromEmail,
          fromName: letter.fromName,
          toEmail: letter.toEmail,
          subject: letter.subject,
          body: letter.body,
          headers: headersOf(letter),
          sentAt: letter.sentAt,
          status: 'draft',
          documentId,
          correspondentId,
          correspondentMatch: match?.match ?? null,
          attachmentIds: planned.map((item) => item.fileId),
        })
        .returning({ id: mailMessages.id })
      if (!row) throw new Error('запись письма не создана')

      await publishEvent(tx, ctx, {
        type: 'mail.received',
        object: { id: documentId, type: 'document', spaceId },
        payload: {
          messageId: row.id,
          integrationId: mailbox.integrationId,
          documentId,
          from: letter.fromEmail,
          subject: letter.subject,
          attachments: planned.length,
        },
      })
      return documentId
    })
  } catch (error) {
    // Транзакция не прошла: байты вложений остались бы в хранилище сиротами
    for (const attachment of planned) {
      await deleteObject(attachment.storageKey, fileBuckets.files()).catch(() => undefined)
    }
    throw error
  }

  // Вложения письма играют роль скана при обычной регистрации: первое
  // становится основным файлом версии, остальные — приложениями. Без версии
  // входящее не зарегистрировать («приложите скан документа»).
  // Отдельной транзакцией: `add` проверяет права на документе, а документа из
  // незавершённой транзакции другое соединение ещё не видит
  const [main, ...rest] = planned
  if (main && created) {
    const documentId = created
    await db()
      .transaction((tx) =>
        DocumentVersionService.add(tx, ctx, documentId, {
          mainFileId: main.fileId,
          attachmentIds: rest.map((item) => item.fileId),
          note: `Из письма ${letter.fromEmail}`.slice(0, 1000),
        }),
      )
      .catch((error: unknown) => {
        // Черновик и вложения на месте — версию делопроизводитель соберёт сам
        logger().warn(
          { documentId, error: String(error) },
          'почта: версия из вложений письма не создана',
        )
      })
  }
}

/** Черновик письма, если он ещё жив: удалённый повторно не трогаем. */
async function aliveDocument(documentId: string) {
  const object = await loadObject(documentId)
  return object && !object.deletedAt ? object : null
}

/**
 * Корреспондент по адресу отправителя, а не нашёлся — по домену ведомства из белого списка
 * (почтовые домены корреспондентов, ADR-0136). Совпадает домен адреса или родительский:
 * `duty@dushanbe.mvd.tj` → `dushanbe.mvd.tj`, затем `mvd.tj`; самый точный домен побеждает.
 * Общие почтовые сервисы по домену не сопоставляются. Не нашёлся — предложим завести.
 */
async function matchCorrespondent(
  email: string,
): Promise<{ id: string; match: MailCorrespondentMatch } | null> {
  if (!email) return null
  const address = email.toLowerCase()
  const [exact] = await db()
    .select({ id: correspondents.id })
    .from(correspondents)
    .innerJoin(objects, eq(objects.id, correspondents.id))
    .where(
      sql`${objects.deletedAt} is null and lower(${correspondents.contacts}->>'email') = ${address}`,
    )
    .limit(1)
  if (exact) return { id: exact.id, match: 'email' }

  const candidates = domainCandidates(address)
  if (candidates.length === 0) return null
  const rows = await db()
    .select({ id: correspondents.id, mailDomains: correspondents.mailDomains })
    .from(correspondents)
    .innerJoin(objects, eq(objects.id, correspondents.id))
    .where(
      and(arrayOverlaps(correspondents.mailDomains, candidates), sql`${objects.deletedAt} is null`),
    )
  // Кандидаты идут от точного к общему: побеждает корреспондент с самым точным доменом
  for (const domain of candidates) {
    const owners = rows.filter((row) => row.mailDomains.includes(domain))
    if (owners.length === 1 && owners[0]) return { id: owners[0].id, match: 'domain' }
    if (owners.length > 1) return null
  }
  return null
}

/** `duty@a.mvd.tj` → [`a.mvd.tj`, `mvd.tj`]; адрес общего почтового сервиса — пусто. */
function domainCandidates(address: string): string[] {
  const domain = address
    .slice(address.lastIndexOf('@') + 1)
    .trim()
    .replace(/\.$/, '')
  if (!address.includes('@') || !domain.includes('.') || isPublicMailDomain(domain)) return []
  const labels = domain.split('.')
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'))
}

type MailRow = typeof mailMessages.$inferSelect

/** Строки очереди — в карточки экрана «Из почты». */
async function records(rows: MailRow[]): Promise<MailMessageRecord[]> {
  if (rows.length === 0) return []

  const documentIds = rows.map((row) => row.documentId).filter((v): v is string => Boolean(v))
  const correspondentIds = rows
    .map((row) => row.correspondentId)
    .filter((v): v is string => Boolean(v))
  const fileIds = [...new Set(rows.flatMap((row) => row.attachmentIds))]
  const deciderIds = [
    ...new Set(rows.map((row) => row.decidedBy).filter((v): v is string => Boolean(v))),
  ]

  const [docs, names, briefs, people, mailboxes] = await Promise.all([
    documentIds.length > 0
      ? db()
          .select({
            id: documents.id,
            status: documents.status,
            regNumber: documents.regNumber,
            deletedAt: objects.deletedAt,
          })
          .from(documents)
          .innerJoin(objects, eq(objects.id, documents.id))
          .where(inArray(documents.id, documentIds))
      : Promise.resolve([]),
    correspondentIds.length > 0
      ? db()
          .select({ id: correspondents.id, kind: correspondents.kind, name: correspondents.name })
          .from(correspondents)
          .where(inArray(correspondents.id, correspondentIds))
      : Promise.resolve([]),
    fileBriefs(fileIds),
    directory().refs(deciderIds),
    Integrations.list(),
  ])

  const docById = new Map(docs.map((row) => [row.id, row]))
  const refById = new Map<string, CorrespondentRef>(
    names.map((row) => [
      row.id,
      { id: row.id, kind: row.kind as CorrespondentKind, name: row.name },
    ]),
  )
  const mailboxById = new Map(mailboxes.map((item) => [item.id, item]))

  return rows.map((row) => {
    const doc = row.documentId ? docById.get(row.documentId) : undefined
    const alive = doc && !doc.deletedAt ? doc : null
    const correspondent = row.correspondentId ? (refById.get(row.correspondentId) ?? null) : null
    const attachments: MailAttachmentRef[] = row.attachmentIds
      .map((id) => briefs.get(id))
      .filter((brief): brief is NonNullable<typeof brief> => Boolean(brief))
      .map((brief) => ({ id: brief.id, name: brief.name, mime: brief.mime, size: brief.size }))
    return {
      id: row.id,
      integrationId: row.integrationId,
      integrationName: row.integrationId
        ? (mailboxById.get(row.integrationId)?.name ?? null)
        : null,
      messageKey: row.messageKey,
      fromEmail: row.fromEmail,
      fromName: row.fromName,
      toEmail: row.toEmail,
      subject: row.subject,
      body: row.body,
      sentAt: row.sentAt,
      receivedAt: row.receivedAt,
      status: row.status as MailMessageStatus,
      documentId: alive?.id ?? null,
      documentStatus: alive ? (alive.status as DocumentStatus) : null,
      documentRegNumber: alive?.regNumber ?? null,
      correspondent,
      correspondentMatch: correspondent
        ? ((row.correspondentMatch as MailCorrespondentMatch | null) ?? null)
        : null,
      suggestedCorrespondentName: correspondent ? null : (row.fromName ?? (row.fromEmail || null)),
      attachments,
      error: row.error,
      rejectReason: row.rejectReason,
      decidedBy: row.decidedBy ? (people.get(row.decidedBy) ?? null) : null,
      decidedAt: row.decidedAt,
      purgeAt: purgeAtOf(row),
      createdAt: row.createdAt,
    }
  })
}

/** Когда запись уйдёт из очереди: только отклонённые и неразобранные (ADR-0136). */
function purgeAtOf(row: MailRow): string | null {
  if (!(MAIL_PURGED_STATUSES as readonly string[]).includes(row.status)) return null
  const from = new Date(row.decidedAt ?? row.receivedAt).getTime()
  return new Date(from + MAIL_QUEUE_RETENTION_DAYS * DAY_MS).toISOString()
}
