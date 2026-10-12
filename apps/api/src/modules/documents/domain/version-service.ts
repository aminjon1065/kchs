import {
  type DocumentFileRef,
  type DocumentManifest,
  type DocumentPdfResult,
  type DocumentStatus,
  type DocumentVersionInput,
  type DocumentVersionRecord,
  engineJobRef,
  isDocumentClosed,
  type PdfStatus,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { engineJob } from '~/kernel/jobs/engine.js'
import { JobService } from '~/kernel/jobs/service.js'
import { LinkService } from '~/kernel/links/service.js'
import { objects } from '~/kernel/objects/schema.js'
import {
  type FileContentPolicy,
  type FileVersionSource,
  type FrozenFile,
  fileBriefs,
  fileBuckets,
  fileStorageKey,
  fileVersionBriefs,
  registerGeneratedFile,
} from '~/modules/files/public.js'
import { type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { documents, documentVersions } from '../schema.js'
import { buildManifest, canonicalJson, manifestHash } from './routes/manifest.js'
import { DocumentSignatures } from './routes/signatures.js'
import { ROUTE_ACTIVE_STATUSES, ROUTE_START_STATUSES } from './routes/state.js'

/** Задание движка: хэш основного файла и, если нужно, PDF-представление (ADR-0080). */
export const PDF_JOB = engineJobRef('render:document.pdf')

const OFFICE = /\.(docx?|odt|rtf|xlsx?|ods|pptx?|odp)$/i
const IMAGE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i

/** Как получить PDF-представление: сам файл, перевод движком или никак. */
export function pdfPlan(file: { name: string; mime: string }): 'self' | 'convert' | 'none' {
  if (file.mime === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'self'
  if (
    file.mime.startsWith('image/') ||
    IMAGE.test(file.name) ||
    OFFICE.test(file.name) ||
    file.mime.includes('officedocument') ||
    file.mime.includes('opendocument') ||
    file.mime === 'application/msword' ||
    file.mime === 'application/rtf'
  ) {
    return 'convert'
  }
  return 'none'
}

function pdfName(name: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.pdf`
}

type VersionRow = typeof documentVersions.$inferSelect

/** Файлы версии: основной, приложения и PDF-представление — без пустых. */
function versionFileIds(row: {
  mainFileId: string | null
  pdfFileId: string | null
  attachments: string[]
}): string[] {
  return [row.mainFileId, row.pdfFileId, ...row.attachments].filter((v): v is string => !!v)
}

/**
 * Почему содержимое документа сейчас не меняется (ADR-0197) — одно правило для
 * новой версии документа и для файлов в его версиях:
 *  - закрыт (исполнен, в деле, в архиве, аннулирован);
 *  - на согласовании или подписи — версия заморожена за шагом;
 *  - уже прошёл согласование или подпись (есть замороженная версия), а статус не
 *    «Черновик» и не «Возвращён»: согласованное и подписанное не меняется,
 *    исправление — новым документом;
 *  - файлы уничтожены по акту.
 * Входящий, зарегистрированный без маршрута, новую версию принимает.
 */
export type ContentBlocker = 'closed' | 'route_active' | 'frozen' | 'destroyed'

export function contentBlocker(input: {
  status: DocumentStatus
  hasFinal: boolean
  filesDestroyed: boolean
}): ContentBlocker | null {
  if (input.filesDestroyed) return 'destroyed'
  if (isDocumentClosed(input.status)) return 'closed'
  if (ROUTE_ACTIVE_STATUSES.includes(input.status)) return 'route_active'
  if (input.hasFinal && !ROUTE_START_STATUSES.includes(input.status)) return 'frozen'
  return null
}

const BLOCKER_MESSAGES: Record<ContentBlocker, string> = {
  closed: 'Документ закрыт — новую версию не добавить',
  route_active: 'Документ на согласовании — новая версия после возврата',
  frozen:
    'Документ согласован или подписан — его версия не меняется; исправление оформляется новым документом',
  destroyed: 'Файлы документа уничтожены по акту — версию не добавить',
}

/** Ошибка правила содержимого: `data.reason` — причина для текста интерфейса. */
export function contentBlockerError(blocker: ContentBlocker): AppError {
  return new AppError('conflict', BLOCKER_MESSAGES[blocker], 409, { data: { reason: blocker } })
}

/** Документы из списка, у которых есть замороженная версия: ходили на согласование или подпись. */
async function finalDocuments(executor: Executor, documentIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(documentIds)]
  if (ids.length === 0) return new Set()
  const rows = await executor
    .selectDistinct({ documentId: documentVersions.documentId })
    .from(documentVersions)
    .where(and(inArray(documentVersions.documentId, ids), eq(documentVersions.isFinal, true)))
  return new Set(rows.map((row) => row.documentId))
}

/**
 * Строка документа под блокировкой и правило содержимого: новая версия и правка
 * файла версии проверяют его в одной транзакции с записью (ADR-0123, ADR-0197).
 */
async function lockForContent(
  tx: Tx,
  documentId: string,
): Promise<{ id: string; spaceId: string; title: string; blocker: ContentBlocker | null }> {
  const [doc] = await tx
    .select({
      id: documents.id,
      status: documents.status,
      filesDestroyedAt: documents.filesDestroyedAt,
      spaceId: objects.spaceId,
      title: objects.title,
    })
    .from(documents)
    .innerJoin(objects, eq(objects.id, documents.id))
    .where(eq(documents.id, documentId))
    .limit(1)
    .for('update', { of: documents })
  if (!doc) throw errors.notFound('Документ')
  if (!doc.spaceId) throw errors.internal('Документ вне пространства')
  const hasFinal = (await finalDocuments(tx, [doc.id])).has(doc.id)
  return {
    id: doc.id,
    spaceId: doc.spaceId,
    title: doc.title,
    blocker: contentBlocker({
      status: doc.status as DocumentStatus,
      hasFinal,
      filesDestroyed: doc.filesDestroyedAt !== null,
    }),
  }
}

/** Закреплённая версия файла: из карты версии, иначе — текущая (до миграции её не было). */
function pinOf(row: { fileVersions: Record<string, string> }, fileId: string): string | null {
  return row.fileVersions[fileId] ?? null
}

async function toRecords(rows: VersionRow[]): Promise<DocumentVersionRecord[]> {
  const fileIds = [
    ...new Set([
      ...rows.flatMap(versionFileIds),
      ...rows.map((row) => row.signedCopyFileId).filter((v): v is string => !!v),
    ]),
  ]
  const pinned = [
    ...new Set(
      rows.flatMap((row) =>
        versionFileIds(row)
          .map((id) => pinOf(row, id))
          .filter((v): v is string => !!v),
      ),
    ),
  ]
  const [briefs, versions, people] = await Promise.all([
    fileBriefs(fileIds),
    fileVersionBriefs(pinned),
    directory().refs([
      ...new Set(rows.map((row) => row.createdBy).filter((v): v is string => !!v)),
    ]),
  ])
  const refOf =
    (row: VersionRow) =>
    (id: string | null): DocumentFileRef | null => {
      const brief = id ? briefs.get(id) : undefined
      if (!id || !brief) return null
      const pin = pinOf(row, id)
      const version = pin ? versions.get(pin) : undefined
      if (!version) {
        return {
          id: brief.id,
          name: brief.name,
          mime: brief.mime,
          size: brief.size,
          versionId: brief.currentVersionId,
          current: true,
        }
      }
      return {
        id: brief.id,
        name: brief.name,
        mime: version.mime,
        size: version.size,
        versionId: version.versionId,
        current: version.current,
      }
    }
  return rows.map((row) => {
    const ref = refOf(row)
    return {
      id: row.id,
      number: row.number,
      mainFile: ref(row.mainFileId),
      pdfFile: ref(row.pdfFileId),
      pdfStatus: row.pdfStatus as PdfStatus,
      attachments: row.attachments.map(ref).filter((v): v is DocumentFileRef => v !== null),
      hash: row.hash,
      note: row.note,
      isFinal: row.isFinal,
      manifestHash: row.manifestHash,
      signedCopy: ref(row.signedCopyFileId),
      createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt,
    }
  })
}

interface InsertInput {
  mainFileId: string
  attachmentIds: string[]
  note: string | null
  /** Закреплённые версии файлов; не указанные — текущие. */
  pins?: Record<string, string>
  /** Версия родилась из правки файла (ADR-0197). */
  origin?: { fileId: string; source: FileVersionSource }
}

/**
 * Запись версии в транзакции вызывающего (права и правило содержимого он уже
 * проверил, строка документа заблокирована): номер, закреплённые версии файлов,
 * текущая версия документа, задание хэша и PDF-представления, событие.
 */
async function insertVersion(
  tx: Tx,
  ctx: Ctx,
  doc: { id: string; spaceId: string; title: string },
  input: InsertInput,
): Promise<string> {
  const fileIds = [input.mainFileId, ...input.attachmentIds]
  const briefs = await fileBriefs(fileIds, tx)
  const main = briefs.get(input.mainFileId)
  if (!main) throw errors.notFound('Файл')

  const pins: Record<string, string> = {}
  for (const id of fileIds) {
    const pin = input.pins?.[id] ?? briefs.get(id)?.currentVersionId
    if (pin) pins[id] = pin
  }
  // Хэш и PDF строятся из закреплённых байтов основного файла
  const mainPin = pins[main.id]
  const mainVersion = mainPin ? (await fileVersionBriefs([mainPin], tx)).get(mainPin) : undefined
  const source = mainVersion
    ? { name: main.name, mime: mainVersion.mime, storageKey: mainVersion.storageKey }
    : { name: main.name, mime: main.mime, storageKey: main.storageKey }

  const [last] = await tx
    .select({ number: sql<number>`coalesce(max(${documentVersions.number}), 0)::int` })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, doc.id))
  const number = (last?.number ?? 0) + 1
  const plan = pdfPlan(source)
  const id = newId()
  await tx.insert(documentVersions).values({
    id,
    documentId: doc.id,
    number,
    mainFileId: main.id,
    pdfFileId: plan === 'self' ? main.id : null,
    pdfStatus: plan === 'self' ? 'ready' : plan === 'convert' ? 'pending' : 'unsupported',
    attachments: input.attachmentIds,
    createdBy: ctx.kind === 'user' ? ctx.userId : ctx.initiatorId,
    note: input.note,
    fileVersions: pins,
  })
  await tx.update(documents).set({ currentVersionId: id }).where(eq(documents.id, doc.id))

  // PDF-представление — отдельный файл под заранее выданными идентификаторами
  const pdfFileId = plan === 'convert' ? newId() : null
  const pdfVersionId = plan === 'convert' ? newId() : null
  // Приложения — только на хэш, для манифеста подписи (ADR-0198)
  const attachmentVersions = await fileVersionBriefs(
    input.attachmentIds.map((fileId) => pins[fileId]).filter((v): v is string => !!v),
    tx,
  )
  const attachments = [...attachmentVersions.values()].map((version) => ({
    fileId: version.fileId,
    bucket: fileBuckets.files(),
    storageKey: version.storageKey,
  }))
  await JobService.schedule(tx, ctx, {
    ...engineJob('render:document.pdf', {
      documentId: doc.id,
      versionId: id,
      name: source.name,
      mime: source.mime,
      bucket: fileBuckets.files(),
      storageKey: source.storageKey,
      convert: plan === 'convert',
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(pdfFileId && pdfVersionId
        ? {
            target: {
              fileId: pdfFileId,
              versionId: pdfVersionId,
              bucket: fileBuckets.files(),
              storageKey: fileStorageKey(doc.spaceId, pdfFileId, pdfVersionId, pdfName(main.name)),
            },
          }
        : {}),
    }),
    objectId: doc.id,
    idempotencyKey: `document.pdf:${id}`,
    callbackScope: `document-version:${id}`,
    options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  })

  await publishEvent(tx, ctx, {
    type: 'document.version_added',
    object: { id: doc.id, type: 'document', spaceId: doc.spaceId, title: doc.title },
    payload: {
      versionId: id,
      number,
      mainFileId: main.id,
      ...(input.origin ? { fileId: input.origin.fileId, source: input.origin.source } : {}),
    },
  })
  return id
}

/** Примечание к версии, родившейся из правки файла. */
const ORIGIN_NOTES: Record<FileVersionSource, string> = {
  editor: 'documents.versions.origin.editor',
  upload: 'documents.versions.origin.upload',
  restore: 'documents.versions.origin.restore',
}

/**
 * Версии документа (08-documents.md §8, P3-E02 S03): основной файл и приложения
 * — объекты `file`, прикреплённые к документу (права — от документа, ADR-0042);
 * номер версии, примечание, хэш и PDF-представление. Хэш и PDF строит движок
 * заданием `render:document.pdf`; признак `is_final` (заморозка) ставит
 * согласование во второй волне.
 */
export const DocumentVersionService = {
  async list(ctx: Ctx, documentId: string): Promise<DocumentVersionRecord[]> {
    await authorize(ctx, 'view', documentId)
    const rows = await db()
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.number))
    return toRecords(rows)
  },

  async record(
    executor: Executor,
    versionId: string | null,
  ): Promise<DocumentVersionRecord | null> {
    if (!versionId) return null
    const [row] = await executor
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1)
    if (!row) return null
    const [record] = await toRecords([row])
    return record ?? null
  },

  async count(executor: Executor, documentId: string): Promise<number> {
    const [row] = await executor
      .select({ total: sql<number>`count(*)::int` })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
    return row?.total ?? 0
  },

  /**
   * Новая версия: основной файл и приложения уже прикреплены к документу
   * (загрузка с `attachToObjectId`). Становится текущей; хэш и PDF — заданием.
   */
  async add(tx: Tx, ctx: Ctx, documentId: string, input: DocumentVersionInput): Promise<string> {
    await authorize(ctx, 'add_version', documentId)
    const doc = await lockForContent(tx, documentId)
    // Согласующие и подписанты решают по замороженной версии, а согласованное и
    // подписанное не меняется (08-documents.md §4, ADR-0197)
    if (doc.blocker) throw contentBlockerError(doc.blocker)

    const fileIds = [input.mainFileId, ...input.attachmentIds]
    if (new Set(fileIds).size !== fileIds.length) {
      throw errors.validation('Файл указан дважды', [
        { path: 'attachmentIds', message: 'duplicate' },
      ])
    }
    // Файлы версии — вложения этого документа: их права выводятся из документа
    const attached = new Set(await LinkService.attachments(documentId, tx))
    const missing = fileIds.filter((id) => !attached.has(id))
    if (missing.length > 0) {
      throw errors.validation('Файл версии не прикреплён к документу', [
        { path: 'mainFileId', message: 'not_attached' },
      ])
    }
    return insertVersion(tx, ctx, doc, {
      mainFileId: input.mainFileId,
      attachmentIds: input.attachmentIds,
      note: input.note,
    })
  },

  /** Почему содержимое документа сейчас не меняется; null — меняется (ADR-0197). */
  async blocker(
    executor: Executor,
    doc: { id: string; status: DocumentStatus; filesDestroyedAt: string | null },
  ): Promise<ContentBlocker | null> {
    return contentBlocker({
      status: doc.status,
      hasFinal: (await finalDocuments(executor, [doc.id])).has(doc.id),
      filesDestroyed: doc.filesDestroyedAt !== null,
    })
  },

  /** Закреплённые версии файлов версии документа: файл → версия файла (ADR-0197). */
  async pins(executor: Executor, versionId: string | null): Promise<Record<string, string>> {
    if (!versionId) return {}
    const [row] = await executor
      .select({ fileVersions: documentVersions.fileVersions })
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1)
    return row?.fileVersions ?? {}
  },

  /**
   * Отчёт движка: SHA-256 основного файла и PDF-представление. PDF принимается
   * только под ключом файла, выданным для этой версии, и становится файлом,
   * прикреплённым к документу (права — от документа).
   */
  async applyPdfResult(versionId: string, input: DocumentPdfResult): Promise<{ stale: boolean }> {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: documentVersions.id,
          documentId: documentVersions.documentId,
          number: documentVersions.number,
          mainFileId: documentVersions.mainFileId,
          pdfFileId: documentVersions.pdfFileId,
          pdfStatus: documentVersions.pdfStatus,
          attachments: documentVersions.attachments,
          fileVersions: documentVersions.fileVersions,
          hashes: documentVersions.hashes,
          createdBy: documentVersions.createdBy,
          spaceId: objects.spaceId,
          title: objects.title,
        })
        .from(documentVersions)
        .innerJoin(objects, eq(objects.id, documentVersions.documentId))
        .where(eq(documentVersions.id, versionId))
        .limit(1)
        .for('update', { of: documentVersions })
      if (!row?.spaceId) return { stale: true }

      const values: Record<string, unknown> = {}
      // Хэши файлов версии — для манифеста подписи (ADR-0198)
      const hashes: Record<string, string> = { ...row.hashes }
      if (input.sha256) {
        values.hash = input.sha256
        if (row.mainFileId) hashes[row.mainFileId] = input.sha256
      }
      for (const [fileId, sha256] of Object.entries(input.attachments ?? {})) {
        if (row.attachments.includes(fileId)) hashes[fileId] = sha256
      }
      let pdfFileId = row.pdfFileId
      const pins = { ...row.fileVersions }
      let status: PdfStatus | null = null
      if (row.pdfStatus === 'pending') {
        if (input.status === 'ready' && input.storageKey && input.pdfFileId && input.pdfVersionId) {
          const prefix = `spaces/${row.spaceId}/files/${input.pdfFileId}/${input.pdfVersionId}/`
          if (!input.storageKey.startsWith(prefix)) {
            throw errors.validation('PDF-представление вне каталога своей версии', [
              { path: 'storageKey', message: 'prefix' },
            ])
          }
          const main = row.mainFileId
            ? (await fileBriefs([row.mainFileId])).get(row.mainFileId)
            : null
          const ctx = systemCtx('documents.pdf', { initiatorId: null })
          const fileId = await registerGeneratedFile(tx, ctx, {
            fileId: input.pdfFileId,
            versionId: input.pdfVersionId,
            spaceId: row.spaceId,
            name: pdfName(main?.name ?? 'document'),
            mime: 'application/pdf',
            size: input.size ?? 0,
            storageKey: input.storageKey,
            checksum: null,
            attachToObjectId: row.documentId,
          })
          values.pdfFileId = fileId
          pdfFileId = fileId
          // PDF-представление тоже закреплено: его единственная версия (ADR-0197)
          pins[fileId] = input.pdfVersionId
          values.fileVersions = pins
          if (input.pdfSha256) hashes[fileId] = input.pdfSha256
          status = 'ready'
        } else {
          status = input.status === 'ready' || input.status === 'skipped' ? 'failed' : input.status
        }
        values.pdfStatus = status
      }
      if (canonicalJson(hashes) !== canonicalJson(row.hashes)) values.hashes = hashes
      const manifest = buildManifest({
        documentId: row.documentId,
        number: row.number,
        mainFileId: row.mainFileId,
        pdfFileId,
        attachments: row.attachments,
        fileVersions: pins,
        hashes,
      })
      const digest = manifest ? manifestHash(manifest) : null
      if (digest) values.manifestHash = digest
      if (Object.keys(values).length === 0) return { stale: false }
      await tx.update(documentVersions).set(values).where(eq(documentVersions.id, versionId))
      // Подписи, поставленные до отчёта движка, получают хэш: манифеста, если он
      // полон, иначе — основного файла, как до манифеста (ADR-0083, ADR-0198)
      if (manifest && digest) {
        await DocumentSignatures.fillHash(tx, versionId, { hash: digest, manifest })
      } else if (input.sha256) {
        await DocumentSignatures.fillHash(tx, versionId, { hash: input.sha256, manifest: null })
      }
      if (status) {
        await publishEvent(tx, systemCtx('documents.pdf'), {
          type: 'document.version_pdf_ready',
          object: { id: row.documentId, type: 'document', spaceId: row.spaceId, title: row.title },
          payload: { versionId, status },
        })
      }
      if (input.error) {
        logger().warn({ versionId, error: input.error }, 'PDF-представление версии не построено')
      }
      return { stale: false }
    })
  },

  /**
   * Манифест версии, если он полон (ADR-0198): подпись фиксирует его хэш.
   * Без манифеста — null, и подпись берёт хэш основного файла.
   */
  async manifest(
    executor: Executor,
    versionId: string,
  ): Promise<{ manifest: DocumentManifest; hash: string } | null> {
    const [row] = await executor
      .select({
        documentId: documentVersions.documentId,
        number: documentVersions.number,
        mainFileId: documentVersions.mainFileId,
        pdfFileId: documentVersions.pdfFileId,
        attachments: documentVersions.attachments,
        fileVersions: documentVersions.fileVersions,
        hashes: documentVersions.hashes,
        manifestHash: documentVersions.manifestHash,
      })
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1)
    if (!row?.manifestHash) return null
    const manifest = buildManifest({ ...row })
    return manifest ? { manifest, hash: manifestHash(manifest) } : null
  },
}

/**
 * Политика содержимого файлов для модуля файлов (ADR-0197).
 *
 * Файл заморожен, если входит в версию документа, содержимое которого сейчас не
 * меняется (правило `contentBlocker`), — или это PDF-представление версии: его
 * строит движок, править его нечего. Новая версия файла, который входит в текущую
 * версию незамороженного документа, становится новой версией документа — в той же
 * транзакции, чтобы «сохранил в редакторе — отправил на согласование» уходило на
 * согласование уже с правкой.
 */
export const documentFilePolicy: FileContentPolicy = {
  key: 'documents',

  async frozen(executor, fileIds) {
    const result = new Map<string, FrozenFile>()
    if (fileIds.length === 0) return result
    const ids = sql.join(
      fileIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = await executor
      .select({
        documentId: documentVersions.documentId,
        mainFileId: documentVersions.mainFileId,
        pdfFileId: documentVersions.pdfFileId,
        attachments: documentVersions.attachments,
        status: documents.status,
        filesDestroyedAt: documents.filesDestroyedAt,
      })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(
        or(
          inArray(documentVersions.mainFileId, fileIds),
          inArray(documentVersions.pdfFileId, fileIds),
          sql`${documentVersions.attachments} ?| array[${ids}]::text[]`,
        ),
      )
    if (rows.length === 0) return result
    const final = await finalDocuments(
      executor,
      rows.map((row) => row.documentId),
    )
    const wanted = new Set(fileIds)
    for (const row of rows) {
      // Сгенерированное PDF-представление не правят никогда
      if (row.pdfFileId && row.pdfFileId !== row.mainFileId && wanted.has(row.pdfFileId)) {
        result.set(row.pdfFileId, { reason: 'representation', hostId: row.documentId })
      }
      const blocker = contentBlocker({
        status: row.status as DocumentStatus,
        hasFinal: final.has(row.documentId),
        filesDestroyed: row.filesDestroyedAt !== null,
      })
      if (!blocker) continue
      for (const id of [row.mainFileId, ...row.attachments]) {
        if (id && wanted.has(id) && !result.has(id)) {
          result.set(id, { reason: blocker, hostId: row.documentId })
        }
      }
    }
    return result
  },

  async versionAdded(tx, ctx, input) {
    // Документы, в текущую версию которых входит файл (основным или приложением)
    const rows = await tx
      .select({
        documentId: documents.id,
        versionId: documentVersions.id,
        mainFileId: documentVersions.mainFileId,
        attachments: documentVersions.attachments,
        fileVersions: documentVersions.fileVersions,
      })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
      .where(
        or(
          eq(documentVersions.mainFileId, input.fileId),
          sql`${documentVersions.attachments} ? ${input.fileId}`,
        ),
      )
    for (const row of rows) {
      if (!row.mainFileId || row.fileVersions[input.fileId] === input.versionId) continue
      const doc = await lockForContent(tx, row.documentId)
      if (doc.blocker) throw contentBlockerError(doc.blocker)
      const pins = { ...row.fileVersions, [input.fileId]: input.versionId }
      await insertVersion(tx, ctx, doc, {
        mainFileId: row.mainFileId,
        attachmentIds: row.attachments,
        note: createTranslator('ru')(ORIGIN_NOTES[input.source]),
        pins,
        origin: { fileId: input.fileId, source: input.source },
      })
    }
  },
}
