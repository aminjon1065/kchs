import {
  type DocumentEmail,
  type DocumentEmailInput,
  type DocumentEmailStatus,
  type DocumentMailStatus,
  PRODUCT_NAME,
  parseConfidentiality,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { BrandingService } from '~/kernel/settings/branding.js'
import { getObjectStream } from '~/kernel/storage/s3.js'
import { fileSource } from '~/modules/files/public.js'
import { config } from '~/shared/config/index.js'
import { actorId, type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { correspondents, documentEmails, documentVersions } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { mailAddressOf, mailConfigured, sendMailWithReceipt } from '~/shared/mail/index.js'
import { Correspondence, dispatchable } from './correspondence-service.js'
import { CorrespondentService } from './correspondent-service.js'

/** Задание отправки письма исходящего (очередь `notify`, воркер). */
export const EMAIL_SEND_JOB = 'documents.email-send'

/** Потолок вложений: почтовые серверы ведомств обычно принимают до 20–25 МБ. */
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024

const EmailAddress = z.email()

type EmailRow = typeof documentEmails.$inferSelect

function sender(): string {
  return config().DOCUMENTS_MAIL_FROM || config().SMTP_FROM
}

/** Сегодняшняя дата в поясе установки — дата отметки в реестре отправки. */
function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config().TZ }).format(new Date())
}

function ruDate(value: string | null): string {
  if (!value) return ''
  const [year, month, day] = value.split('-')
  return `${day}.${month}.${year}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Адрес из контактов корреспондента справочника. */
async function correspondentEmail(executor: Executor, id: string | null): Promise<string | null> {
  if (!id) return null
  const [row] = await executor
    .select({ contacts: correspondents.contacts })
    .from(correspondents)
    .where(eq(correspondents.id, id))
    .limit(1)
  const email = (row?.contacts as { email?: string } | undefined)?.email?.trim()
  return email || null
}

/** Файлы письма: PDF текущей версии и, по желанию, приложения. */
async function letterFiles(executor: Executor, versionId: string | null, withAttachments: boolean) {
  if (!versionId) throw errors.conflict('У документа нет версии с файлом — отправлять нечего')
  const [version] = await executor
    .select({
      mainFileId: documentVersions.mainFileId,
      pdfFileId: documentVersions.pdfFileId,
      pdfStatus: documentVersions.pdfStatus,
      attachments: documentVersions.attachments,
    })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .limit(1)
  if (!version) throw errors.conflict('У документа нет версии с файлом — отправлять нечего')
  if (!version.pdfFileId || version.pdfStatus !== 'ready') {
    throw errors.conflict(
      'PDF текущей версии ещё не готов: письмо уходит с PDF — отправьте, когда он появится',
    )
  }
  const ids = [version.pdfFileId, ...(withAttachments ? version.attachments : [])]
  const sources = (await Promise.all(ids.map((id) => fileSource(id)))).filter(
    (source): source is NonNullable<typeof source> => source !== null,
  )
  const total = sources.reduce((sum, source) => sum + source.size, 0)
  if (total > MAX_ATTACHMENTS_BYTES) {
    throw errors.conflict(
      'Вложения больше 20 МБ: серверы адресатов такие письма не принимают — отправьте без приложений',
    )
  }
  return sources
}

function toRecord(
  row: EmailRow,
  names: Map<string, { id: string; kind: 'organization' | 'person'; name: string }>,
  people: Map<string, NonNullable<DocumentEmail['createdBy']>>,
): DocumentEmail {
  return {
    id: row.id,
    to: row.toAddress,
    correspondent: row.correspondentId ? (names.get(row.correspondentId) ?? null) : null,
    status: row.status as DocumentEmailStatus,
    messageId: row.messageId,
    error: row.error,
    withAttachments: row.withAttachments,
    dispatchId: row.dispatchId,
    createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  }
}

async function failEmail(
  email: EmailRow,
  reason: 'error' | 'rejected' | 'bounced',
  message: string,
  object: { id: string; spaceId: string | null; title: string } | null,
): Promise<void> {
  const ctx = systemCtx('documents.mail', { initiatorId: email.createdBy })
  await db().transaction(async (tx) => {
    await tx
      .update(documentEmails)
      .set({ status: reason === 'bounced' ? 'bounced' : 'failed', error: message.slice(0, 1000) })
      .where(eq(documentEmails.id, email.id))
    await publishEvent(tx, ctx, {
      type: 'document.email_failed',
      object: object
        ? { id: object.id, type: 'document', spaceId: object.spaceId, title: object.title }
        : { id: email.documentId, type: 'document' },
      payload: {
        emailId: email.id,
        to: email.toAddress,
        reason,
        error: message.slice(0, 500),
        createdBy: email.createdBy,
      },
    })
  })
}

/**
 * Исходящий письмом из ящика канцелярии (ADR-0149). Постановка проверяет права, статус,
 * гриф и вложения и ставит задание; отправка — в воркере. Отметка в реестре отправки
 * появляется, только когда сервер принял письмо: первая переводит исходящий в «Исполнен»,
 * как и отметка вручную.
 */
export const DocumentMailOut = {
  status(): DocumentMailStatus {
    const configured = mailConfigured()
    return { configured, from: configured ? sender() : null }
  },

  async queue(
    tx: Executor,
    ctx: UserCtx,
    documentId: string,
    input: DocumentEmailInput,
  ): Promise<string> {
    await authorize(ctx, 'dispatch', documentId)
    const { row } = await dispatchable(tx, documentId)
    if (!mailConfigured()) {
      throw errors.conflict('Почта установки не настроена: письма не уходят (SMTP_URL)')
    }
    // Исходник с грифом от «конфиденциально» наружу не уходит (ADR-0085)
    if (parseConfidentiality(row.confidentiality) === 'confidential') {
      throw new AppError(
        'forbidden',
        'Документ с грифом «Конфиденциально» почтой не отправляется',
        403,
      )
    }
    const correspondentId = input.correspondentId ?? row.correspondentId ?? null
    const to = input.to ?? (await correspondentEmail(tx, correspondentId))
    if (!to || !EmailAddress.safeParse(to).success) {
      throw errors.validation('Нужен адрес электронной почты адресата', [
        {
          path: 'to',
          message: 'У корреспондента нет адреса — введите его',
          code: 'email_required',
        },
      ])
    }
    await letterFiles(tx, row.currentVersionId, input.attachments)

    const emailId = newId()
    await tx.insert(documentEmails).values({
      id: emailId,
      documentId,
      correspondentId,
      toAddress: to,
      message: input.message,
      withAttachments: input.attachments,
      status: 'queued',
      createdBy: actorId(ctx),
    })
    await JobService.schedule(tx, ctx, {
      queue: 'notify',
      name: EMAIL_SEND_JOB,
      objectId: documentId,
      data: { emailId },
    })
    await publishEvent(tx, ctx, {
      type: 'document.email_queued',
      object: { id: documentId, type: 'document', spaceId: row.spaceId, title: row.title },
      payload: { emailId, to },
    })
    return emailId
  },

  /** Повтор письма, которое не ушло или вернулось: новое задание, тот же адрес. */
  async retry(tx: Executor, ctx: UserCtx, documentId: string, emailId: string): Promise<string> {
    await authorize(ctx, 'dispatch', documentId)
    const { row } = await dispatchable(tx, documentId)
    const [email] = await tx
      .select()
      .from(documentEmails)
      .where(and(eq(documentEmails.id, emailId), eq(documentEmails.documentId, documentId)))
      .limit(1)
    if (!email) throw errors.notFound('Письмо')
    if (email.status !== 'failed' && email.status !== 'bounced') {
      throw errors.conflict('Повторить можно письмо, которое не ушло или вернулось')
    }
    await tx
      .update(documentEmails)
      .set({ status: 'queued', error: null, messageId: null })
      .where(eq(documentEmails.id, emailId))
    await JobService.schedule(tx, ctx, {
      queue: 'notify',
      name: EMAIL_SEND_JOB,
      objectId: documentId,
      data: { emailId },
    })
    await publishEvent(tx, ctx, {
      type: 'document.email_queued',
      object: { id: documentId, type: 'document', spaceId: row.spaceId, title: row.title },
      payload: { emailId, to: email.toAddress },
    })
    return emailId
  },

  async list(ctx: UserCtx, documentId: string): Promise<DocumentEmail[]> {
    await authorize(ctx, 'view', documentId)
    const rows = await db()
      .select()
      .from(documentEmails)
      .where(eq(documentEmails.documentId, documentId))
      .orderBy(desc(documentEmails.createdAt))
    const [names, people] = await Promise.all([
      CorrespondentService.names(db(), [
        ...new Set(rows.map((row) => row.correspondentId).filter((v): v is string => !!v)),
      ]),
      directory().refs([
        ...new Set(rows.map((row) => row.createdBy).filter((v): v is string => !!v)),
      ]),
    ])
    return rows.map((row) => toRecord(row, names, people))
  },

  /** Задание воркера: письмо уходит, отметка ставится; сбой — состояние и уведомление. */
  async send(emailId: string): Promise<{ status: DocumentEmailStatus | 'skipped' }> {
    const [email] = await db()
      .select()
      .from(documentEmails)
      .where(eq(documentEmails.id, emailId))
      .limit(1)
    if (email?.status !== 'queued') return { status: 'skipped' }

    let row: Awaited<ReturnType<typeof dispatchable>>['row']
    try {
      row = (await dispatchable(db(), email.documentId)).row
      // Гриф мог подняться, пока письмо ждало очереди
      if (parseConfidentiality(row.confidentiality) === 'confidential') {
        throw new Error('Документ с грифом «Конфиденциально» почтой не отправляется')
      }
    } catch (error) {
      await failEmail(
        email,
        'error',
        error instanceof Error ? error.message : 'не отправлено',
        null,
      )
      return { status: 'failed' }
    }
    const object = { id: row.id, spaceId: row.spaceId, title: row.title }

    const from = sender()
    const domain = mailAddressOf(from).split('@')[1] || 'kchs.local'
    const messageId = `<kchs-${email.id}@${domain}>`
    const t = createTranslator('ru')
    const number = row.regNumber ?? ''
    const date = ruDate(row.regDate)
    let receipt: Awaited<ReturnType<typeof sendMailWithReceipt>>
    try {
      const sources = await letterFiles(db(), row.currentVersionId, email.withAttachments)
      const attachments = await Promise.all(
        sources.map(async (source, index) => ({
          // PDF версии — по номеру документа: так его узнают в почте адресата
          filename:
            index === 0 && number ? `${number.replaceAll(/[\\/:*?"<>|]/g, '-')}.pdf` : source.name,
          content: (await getObjectStream(source.storageKey, { bucket: source.bucket })).body,
          contentType: source.mime,
        })),
      )
      const organization = (await BrandingService.current()).name
      const params = { number, date, subject: row.subject || row.title }
      const lines = [
        t('documents.mail.out.greeting'),
        t('documents.mail.out.lead', params),
        ...(email.message ? [email.message] : []),
        t('documents.mail.out.files', {
          files: attachments.map((file) => file.filename).join(', '),
        }),
        ...(organization ? [organization] : []),
        t('documents.mail.out.footer', { product: PRODUCT_NAME }),
      ]
      receipt = await sendMailWithReceipt({
        from,
        replyTo: mailAddressOf(from),
        to: email.toAddress,
        subject: t('documents.mail.out.subject', params),
        text: lines.join('\n\n'),
        html: lines.map((line) => `<p>${escapeHtml(line).replaceAll('\n', '<br>')}</p>`).join(''),
        messageId,
        attachments,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'почтовый сервер не принял письмо'
      logger().warn({ emailId, error: message }, 'письмо исходящего не ушло')
      await failEmail(email, 'error', message, object)
      return { status: 'failed' }
    }
    if (!receipt) {
      await failEmail(email, 'error', 'Почта установки не настроена (SMTP_URL)', object)
      return { status: 'failed' }
    }
    if (receipt.accepted.length === 0) {
      await failEmail(
        email,
        'rejected',
        `Сервер отклонил адрес ${email.toAddress}: ${receipt.response}`,
        object,
      )
      return { status: 'failed' }
    }

    const ctx: Ctx = systemCtx('documents.mail', { initiatorId: email.createdBy })
    await db().transaction(async (tx) => {
      let dispatchId: string | null = null
      try {
        // Отметка — в точке сохранения: статус мог смениться, а письмо уже ушло
        dispatchId = await tx.transaction((savepoint) =>
          Correspondence.dispatch(savepoint, ctx, row.id, {
            correspondentId: email.correspondentId,
            addressee: email.toAddress,
            method: 'email',
            sentOn: localToday(),
            tracking: receipt.messageId,
            note: null,
          }),
        )
      } catch (error) {
        logger().warn(
          { emailId, error: error instanceof Error ? error.message : error },
          'письмо ушло, но отметку отправки поставить не удалось',
        )
      }
      await tx
        .update(documentEmails)
        .set({
          status: 'sent',
          messageId: receipt.messageId,
          error: null,
          dispatchId,
          sentAt: new Date().toISOString(),
        })
        .where(eq(documentEmails.id, email.id))
      await publishEvent(tx, ctx, {
        type: 'document.email_sent',
        object: { id: row.id, type: 'document', spaceId: row.spaceId, title: row.title },
        payload: {
          emailId: email.id,
          to: email.toAddress,
          messageId: receipt.messageId,
          dispatchId,
        },
      })
    })
    return { status: 'sent' }
  },

  /**
   * Уведомление о недоставке из ящика канцелярии (приём из почты): находит своё письмо по
   * Message-ID и отмечает его «вернулось». `true` — письмо наше, в очередь оно не идёт.
   */
  async bounced(messageIds: string[], reason: string): Promise<boolean> {
    const ids = messageIds.filter((id) => /^<kchs-[0-9a-f-]{36}@/i.test(id))
    if (ids.length === 0) return false
    const [email] = await db()
      .select()
      .from(documentEmails)
      .where(inArray(documentEmails.messageId, ids))
      .limit(1)
    if (!email) return false
    if (email.status === 'sent') await failEmail(email, 'bounced', reason, null)
    return true
  },
}
