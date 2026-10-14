import type {
  CorrespondentKind,
  GovEdmsOutgoingState,
  GovEdmsPackage,
  GovEdmsTransferInput,
  GovEdmsTransferResult,
} from '@kchs/contracts'
import { and, asc, eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { authorize } from '~/kernel/access/authorize.js'
import { audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { buckets, getObjectStream, putObject, safeName, signedGetUrl } from '~/kernel/storage/s3.js'
import { fileVersionSource } from '~/modules/files/public.js'
import { EdmsSends } from '~/modules/integrations/public.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import {
  correspondents,
  documentDispatches,
  documentSignatures,
  documentVersions,
} from '../../schema.js'
import { DOCUMENTS_AUDIT } from '../audit-actions.js'
import { Correspondence, dispatchable } from '../correspondence-service.js'
import { DocumentService } from '../document-service.js'
import { DocumentTypeService } from '../type-service.js'

/**
 * Исходящие в госЭДО (ADR-0219). Госсистема закрыта, поэтому порт ЭДО (ADR-0206)
 * работает провайдером «ручной обмен»: регистрация исходящего адресату, который
 * обменивается через госЭДО, ставит отправку в очередь и открывает регистратору дело
 * «Передать в госЭДО». Делопроизводитель скачивает пакет (подписанный экземпляр,
 * приложения, карточка реквизитов), загружает его в госсистему и отмечает передачу —
 * отметка ложится в реестр отправки способом «госЭДО», отправка в очереди получает
 * номер в госсистеме, дело закрывается.
 */

/** Срок дела «Передать в госЭДО»: конец следующего дня после регистрации. */
const TRANSFER_DUE_HOURS = 36
/** Предел пакета: документ с приложениями, а не архив дела. */
const PACKAGE_LIMIT_BYTES = 200 * 1024 * 1024

async function recipientOf(executor: Executor, correspondentId: string | null) {
  if (!correspondentId) return null
  const [row] = await executor
    .select({
      id: correspondents.id,
      kind: correspondents.kind,
      name: correspondents.name,
      externalId: correspondents.externalId,
      edmsExchange: correspondents.edmsExchange,
    })
    .from(correspondents)
    .where(eq(correspondents.id, correspondentId))
    .limit(1)
  return row ?? null
}

async function readBytes(fileId: string, versionId: string | null | undefined) {
  const source = await fileVersionSource(fileId, versionId)
  if (!source) return null
  const { body } = await getObjectStream(source.storageKey, { bucket: source.bucket })
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return { name: source.name, bytes: new Uint8Array(Buffer.concat(chunks)) }
}

/** Имя в архиве без повторов: «Приложение.pdf», «Приложение (2).pdf». */
function uniqueName(taken: Set<string>, name: string): string {
  const safe = safeName(name) || 'file'
  if (!taken.has(safe)) {
    taken.add(safe)
    return safe
  }
  const dot = safe.lastIndexOf('.')
  const base = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})${ext}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

export const GovEdmsOutgoing = {
  async state(ctx: UserCtx, documentId: string): Promise<GovEdmsOutgoingState> {
    await authorize(ctx, 'view', documentId)
    const row = await DocumentService.load(db(), documentId)
    if (!row) throw errors.notFound('Документ')
    const recipient = await recipientOf(db(), row.correspondentId)
    const dispatches = await Correspondence.dispatches(ctx, documentId)
    return {
      exchange: Boolean(recipient?.edmsExchange),
      recipient: recipient
        ? { id: recipient.id, kind: recipient.kind as CorrespondentKind, name: recipient.name }
        : null,
      pending: await EdmsSends.pendingFor(db(), documentId),
      transfers: dispatches.filter((item) => item.method === 'edms'),
    }
  },

  /**
   * Пакет для ручной загрузки: подписанный экземпляр (или PDF версии, или основной файл),
   * приложения версии и `card.json` с реквизитами. Файлы — закреплённые за версией
   * (ADR-0197), архив живёт в бакете выгрузок, ссылка — 15 минут.
   */
  async package(ctx: UserCtx, documentId: string): Promise<GovEdmsPackage> {
    await authorize(ctx, 'dispatch', documentId)
    const { row } = await dispatchable(db(), documentId)
    if (!row.currentVersionId) throw errors.conflict('У документа нет версии с файлом')
    const [version] = await db()
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, row.currentVersionId))
      .limit(1)
    if (!version?.mainFileId) throw errors.conflict('У документа нет основного файла')
    const pinned = version.fileVersions ?? {}
    const recipient = await recipientOf(db(), row.correspondentId)
    const type = await DocumentTypeService.load(db(), row.typeId)
    const signatures = await db()
      .select({
        signerId: documentSignatures.signerId,
        kind: documentSignatures.kind,
        signedAt: documentSignatures.signedAt,
        hash: documentSignatures.hash,
      })
      .from(documentSignatures)
      .where(
        and(
          eq(documentSignatures.documentId, documentId),
          eq(documentSignatures.versionId, version.id),
        ),
      )
      .orderBy(asc(documentSignatures.signedAt))
    const signers = await directory().refs(signatures.map((item) => item.signerId))

    const files: Record<string, Uint8Array> = {}
    const taken = new Set<string>(['card.json'])
    const listed: Array<{ name: string; role: string }> = []
    let total = 0
    const add = (name: string, bytes: Uint8Array, role: string, folder = '') => {
      total += bytes.byteLength
      if (total > PACKAGE_LIMIT_BYTES) {
        throw errors.conflict('Пакет больше 200 МБ — загрузите файлы в госЭДО по отдельности')
      }
      const entry = `${folder}${uniqueName(taken, name)}`
      files[entry] = bytes
      listed.push({ name: entry, role })
    }

    // Главный файл пакета — подписанный экземпляр со штампами (ADR-0198), иначе PDF версии
    const primary = version.signedCopyFileId
      ? await readBytes(version.signedCopyFileId, null)
      : version.pdfFileId && version.pdfStatus === 'ready'
        ? await readBytes(version.pdfFileId, null)
        : await readBytes(version.mainFileId, pinned[version.mainFileId])
    if (!primary) throw errors.conflict('Файл документа недоступен в хранилище')
    const primaryName = `${row.regNumber ?? 'Документ'}${primary.name.slice(primary.name.lastIndexOf('.'))}`
    add(primaryName, primary.bytes, version.signedCopyFileId ? 'signed_copy' : 'document')
    for (const attachmentId of version.attachments ?? []) {
      const attachment = await readBytes(attachmentId, pinned[attachmentId])
      if (attachment) add(attachment.name, attachment.bytes, 'attachment', 'Приложения/')
    }

    const card = {
      format: 'kchs.gov-edms.package/v1',
      preparedAt: new Date().toISOString(),
      document: {
        id: documentId,
        type: type?.name.ru ?? null,
        regNumber: row.regNumber,
        regDate: row.regDate,
        subject: row.subject,
        summary: row.summary,
        versionNo: version.number,
        manifestHash: version.manifestHash,
      },
      recipient: recipient ? { name: recipient.name, code: recipient.externalId ?? null } : null,
      signatures: signatures.map((item) => ({
        signer: signers.get(item.signerId)?.displayName ?? null,
        kind: item.kind,
        signedAt: item.signedAt,
        hash: item.hash,
      })),
      files: listed,
    }
    files['card.json'] = new TextEncoder().encode(JSON.stringify(card, null, 2))

    const archive = zipSync(files, { level: 6 })
    const name = `${safeName(`${row.regNumber ?? 'Документ'} — госЭДО`)}.zip`
    const key = `gov-edms/${documentId}/${Date.now()}.zip`
    await putObject(key, Buffer.from(archive), {
      bucket: buckets.exports(),
      contentType: 'application/zip',
      contentLength: archive.byteLength,
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'document.edms_package_prepared',
        object: { id: documentId, type: 'document', spaceId: row.spaceId, title: row.title },
        payload: { files: listed.length, size: archive.byteLength },
      })
      await audit(
        ctx,
        {
          action: DOCUMENTS_AUDIT.govEdmsPackagePrepared,
          objectId: documentId,
          objectType: 'document',
          details: { files: listed.length, size: archive.byteLength },
        },
        tx,
      )
    })
    return {
      url: await signedGetUrl(key, { bucket: buckets.exports(), filename: name }),
      name,
      size: archive.byteLength,
      files: listed.length + 1,
    }
  },

  /**
   * Отметка «передано в госЭДО»: запись реестра отправки способом «госЭДО» с номером
   * в госсистеме. Закрытие дела и отправки в очереди — подписчик `document.dispatched`,
   * так же, как при отметке из общего диалога отправки.
   */
  async transferred(
    tx: Tx,
    ctx: UserCtx,
    documentId: string,
    input: GovEdmsTransferInput,
  ): Promise<GovEdmsTransferResult> {
    const row = await DocumentService.load(tx, documentId)
    if (!row) throw errors.notFound('Документ')
    const dispatchId = await Correspondence.dispatch(tx, ctx, documentId, {
      correspondentId: row.correspondentId,
      addressee: row.correspondentId ? null : 'госЭДО',
      method: 'edms',
      sentOn: input.sentOn,
      tracking: input.externalNumber,
      note: input.note,
    })
    return { dispatchId }
  },

  /**
   * Исходящий зарегистрирован: адресат обменивается через госЭДО — отправка в очередь
   * ручного обмена и дело «Передать в госЭДО» тому, кто зарегистрировал.
   */
  async onRegistered(documentId: string, actorId: string | null): Promise<void> {
    const row = await DocumentService.load(db(), documentId)
    if (!row) return
    const type = await DocumentTypeService.load(db(), row.typeId)
    if (type?.direction !== 'outgoing') return
    const recipient = await recipientOf(db(), row.correspondentId)
    if (!recipient?.edmsExchange) return
    const ctx: Ctx = systemCtx('documents.gov-edms', { initiatorId: actorId })
    await db().transaction(async (tx) => {
      await EdmsSends.enqueue(tx, ctx, {
        documentId,
        versionNo: null,
        recipient: recipient.externalId ?? recipient.name,
        payload: {
          regNumber: row.regNumber,
          regDate: row.regDate,
          subject: row.subject,
          typeKey: type.key,
          files: [],
          signatures: [],
        },
        idempotencyKey: `gov-edms:${documentId}:${row.regNumber ?? ''}:${recipient.id}`,
      })
      if (!actorId) return
      await InboxService.open(tx, ctx, {
        userId: actorId,
        kind: 'edms_transfer',
        objectId: documentId,
        titleKey: 'inbox.tpl.edmsTransfer',
        dueAt: new Date(Date.now() + TRANSFER_DUE_HOURS * 3_600_000).toISOString(),
        dedupeKey: `edms_transfer:${documentId}`,
        actions: [
          {
            key: 'open',
            labelKey: 'inbox.actions.prepareEdms',
            variant: 'primary',
            requiresComment: false,
            openObject: true,
          },
        ],
      })
    })
  },

  /** Передача в госЭДО отмечена — отправка в очереди и дело закрываются. */
  async onDispatched(
    documentId: string,
    payload: { method?: unknown; dispatchId?: unknown },
    actorId: string | null,
  ): Promise<void> {
    if (payload.method !== 'edms') return
    const ctx: Ctx = systemCtx('documents.gov-edms', { initiatorId: actorId })
    const tracking = await trackingOf(String(payload.dispatchId ?? ''))
    await db().transaction(async (tx) => {
      await EdmsSends.markSent(tx, ctx, { documentId, externalId: tracking ?? '' })
      await InboxService.resolve(tx, ctx, { objectId: documentId, kind: 'edms_transfer' })
    })
  },
}

async function trackingOf(dispatchId: string): Promise<string | null> {
  if (!dispatchId) return null
  const [row] = await db()
    .select({ tracking: documentDispatches.tracking })
    .from(documentDispatches)
    .where(eq(documentDispatches.id, dispatchId))
    .limit(1)
  return row?.tracking ?? null
}
