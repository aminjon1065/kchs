import {
  type DocumentFileRef,
  type DocumentPdfResult,
  type DocumentStatus,
  type DocumentVersionInput,
  type DocumentVersionRecord,
  isDocumentClosed,
  type PdfStatus,
} from '@kchs/contracts'
import { desc, eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { LinkService } from '~/kernel/links/service.js'
import {
  fileBriefs,
  fileBuckets,
  fileStorageKey,
  registerGeneratedFile,
} from '~/modules/files/public.js'
import { type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { documents, documentVersions, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { DocumentSignatures } from './routes/signatures.js'
import { ROUTE_ACTIVE_STATUSES } from './routes/state.js'

/** Задание движка: хэш основного файла и, если нужно, PDF-представление (ADR-0080). */
export const PDF_JOB = { queue: 'render', name: 'document.pdf' } as const

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

async function toRecords(rows: VersionRow[]): Promise<DocumentVersionRecord[]> {
  const fileIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.mainFileId, row.pdfFileId, ...row.attachments].filter((v): v is string => !!v),
      ),
    ),
  ]
  const [briefs, people] = await Promise.all([
    fileBriefs(fileIds),
    directory().refs([
      ...new Set(rows.map((row) => row.createdBy).filter((v): v is string => !!v)),
    ]),
  ])
  const ref = (id: string | null): DocumentFileRef | null => {
    const brief = id ? briefs.get(id) : undefined
    return brief ? { id: brief.id, name: brief.name, mime: brief.mime, size: brief.size } : null
  }
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    mainFile: ref(row.mainFileId),
    pdfFile: ref(row.pdfFileId),
    pdfStatus: row.pdfStatus as PdfStatus,
    attachments: row.attachments.map(ref).filter((v): v is DocumentFileRef => v !== null),
    hash: row.hash,
    note: row.note,
    isFinal: row.isFinal,
    createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt,
  }))
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
  async add(
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    input: DocumentVersionInput,
  ): Promise<string> {
    await authorize(ctx, 'add_version', documentId)
    const [doc] = await tx
      .select({ status: documents.status, spaceId: objects.spaceId, title: objects.title })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(eq(documents.id, documentId))
      .limit(1)
      .for('update', { of: documents })
    if (!doc) throw errors.notFound('Документ')
    if (isDocumentClosed(doc.status as DocumentStatus)) {
      throw errors.conflict('Документ закрыт — новую версию не добавить')
    }
    // Согласующие и подписанты решают по замороженной версии (08-documents.md §4)
    if (ROUTE_ACTIVE_STATUSES.includes(doc.status as DocumentStatus)) {
      throw errors.conflict('Документ на согласовании — новая версия после возврата', {
        reason: 'route_active',
      })
    }
    if (!doc.spaceId) throw errors.internal('Документ вне пространства')

    const fileIds = [input.mainFileId, ...input.attachmentIds]
    if (new Set(fileIds).size !== fileIds.length) {
      throw errors.validation('Файл указан дважды', [
        { path: 'attachmentIds', message: 'duplicate' },
      ])
    }
    // Файлы версии — вложения этого документа: их права выводятся из документа
    const attached = new Set(await LinkService.attachments(documentId))
    const missing = fileIds.filter((id) => !attached.has(id))
    if (missing.length > 0) {
      throw errors.validation('Файл версии не прикреплён к документу', [
        { path: 'mainFileId', message: 'not_attached' },
      ])
    }
    const briefs = await fileBriefs(fileIds, tx)
    const main = briefs.get(input.mainFileId)
    if (!main) throw errors.notFound('Файл')

    const [last] = await tx
      .select({ number: sql<number>`coalesce(max(${documentVersions.number}), 0)::int` })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
    const number = (last?.number ?? 0) + 1
    const plan = pdfPlan(main)
    const id = newId()
    await tx.insert(documentVersions).values({
      id,
      documentId,
      number,
      mainFileId: main.id,
      pdfFileId: plan === 'self' ? main.id : null,
      pdfStatus: plan === 'self' ? 'ready' : plan === 'convert' ? 'pending' : 'unsupported',
      attachments: input.attachmentIds,
      createdBy: ctx.kind === 'user' ? ctx.userId : ctx.initiatorId,
      note: input.note,
    })
    await tx.update(documents).set({ currentVersionId: id }).where(eq(documents.id, documentId))

    // PDF-представление — отдельный файл под заранее выданными идентификаторами
    const pdfFileId = plan === 'convert' ? newId() : null
    const pdfVersionId = plan === 'convert' ? newId() : null
    await JobService.schedule(tx, ctx, {
      queue: PDF_JOB.queue,
      name: PDF_JOB.name,
      objectId: documentId,
      idempotencyKey: `document.pdf:${id}`,
      data: {
        documentId,
        versionId: id,
        name: main.name,
        mime: main.mime,
        bucket: fileBuckets.files(),
        storageKey: main.storageKey,
        convert: plan === 'convert',
        ...(pdfFileId && pdfVersionId
          ? {
              target: {
                fileId: pdfFileId,
                versionId: pdfVersionId,
                bucket: fileBuckets.files(),
                storageKey: fileStorageKey(
                  doc.spaceId,
                  pdfFileId,
                  pdfVersionId,
                  pdfName(main.name),
                ),
              },
            }
          : {}),
      },
      options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    })

    await publishEvent(tx, ctx, {
      type: 'document.version_added',
      object: { id: documentId, type: 'document', spaceId: doc.spaceId, title: doc.title },
      payload: { versionId: id, number, mainFileId: main.id },
    })
    return id
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
          mainFileId: documentVersions.mainFileId,
          pdfStatus: documentVersions.pdfStatus,
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
      if (input.sha256) {
        values.hash = input.sha256
        // Подписи, поставленные до расчёта хэша, получают его (ADR-0083)
        await DocumentSignatures.fillHash(tx, versionId, input.sha256)
      }
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
          status = 'ready'
        } else {
          status = input.status === 'ready' || input.status === 'skipped' ? 'failed' : input.status
        }
        values.pdfStatus = status
      }
      if (Object.keys(values).length === 0) return { stale: false }
      await tx.update(documentVersions).set(values).where(eq(documentVersions.id, versionId))
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

  /** Файлы, которые нельзя открепить от документа: они в его версиях. */
  async versionFiles(executor: Executor, documentId: string): Promise<Set<string>> {
    const rows = await executor
      .select({
        mainFileId: documentVersions.mainFileId,
        pdfFileId: documentVersions.pdfFileId,
        attachments: documentVersions.attachments,
      })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
    return new Set(
      rows.flatMap((row) =>
        [row.mainFileId, row.pdfFileId, ...row.attachments].filter((v): v is string => !!v),
      ),
    )
  },
}
