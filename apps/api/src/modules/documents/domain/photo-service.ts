import { createHash } from 'node:crypto'
import {
  DOCUMENT_PHOTO_MAX_BYTES,
  DOCUMENT_PHOTO_MAX_PER_DOCUMENT,
  type DocumentPhoto,
  type DocumentPhotoUploadInput,
} from '@kchs/contracts'
import { and, count, eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { storeFileBytes } from '~/modules/files/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { cleanJpeg, JpegError } from '~/shared/jpeg.js'
import { documentPhotos, documents } from '../schema.js'
import { documentsSpaceId } from './space.js'

/**
 * Фото черновика документа (ADR-0212): снимок с телефона к донесению, сделанный без
 * сети. Устройство пережимает его в JPEG, сервер очищает от метаданных (как фото
 * сводки, ADR-0208) и кладёт файлом реестра в пространство документооборота,
 * прикреплённым к документу: его видит тот, кто видит документ. Фото добавляются только
 * в черновик — дальше файлы идут версиями документа (ADR-0197).
 */

const NOT_DRAFT = 'Фото добавляются в черновик — дальше файлы идут версиями документа'

type PhotoRow = typeof documentPhotos.$inferSelect

function view(row: PhotoRow): DocumentPhoto {
  return {
    id: row.fileId,
    clientKey: row.clientKey,
    size: row.size,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
  }
}

export const DocumentPhotos = {
  /**
   * Загрузка снимка. Повтор с тем же ключом устройства возвращает уже записанный файл —
   * очередь без сети досылает снимок, пока не дойдёт ответ.
   */
  async upload(
    ctx: UserCtx,
    documentId: string,
    input: DocumentPhotoUploadInput,
  ): Promise<DocumentPhoto> {
    await authorize(ctx, 'edit', documentId)
    const [existing] = await db()
      .select()
      .from(documentPhotos)
      .where(
        and(
          eq(documentPhotos.documentId, documentId),
          eq(documentPhotos.clientKey, input.clientKey),
        ),
      )
      .limit(1)
    if (existing) return view(existing)

    const raw = Buffer.from(input.data, 'base64')
    if (raw.byteLength > DOCUMENT_PHOTO_MAX_BYTES) {
      throw errors.validation('Фото больше 3 МБ — сожмите снимок')
    }
    let clean: ReturnType<typeof cleanJpeg>
    try {
      clean = cleanJpeg(raw)
    } catch (error) {
      if (error instanceof JpegError) throw errors.validation(`Фото не принято: ${error.message}`)
      throw error
    }
    const checksum = createHash('sha256').update(clean.bytes).digest('hex')

    const row = await db().transaction(async (tx) => {
      // Загрузки одного документа — по очереди: статус, лимит и ключ под блокировкой строки
      const [locked] = await tx
        .select({ status: documents.status, subject: documents.subject })
        .from(documents)
        .where(eq(documents.id, documentId))
        .for('update')
      if (!locked) throw errors.notFound('Документ')
      const [again] = await tx
        .select()
        .from(documentPhotos)
        .where(
          and(
            eq(documentPhotos.documentId, documentId),
            eq(documentPhotos.clientKey, input.clientKey),
          ),
        )
        .limit(1)
      if (again) return again
      if (locked.status !== 'draft') throw errors.conflict(NOT_DRAFT, { reason: 'not_draft' })
      const [total] = await tx
        .select({ value: count() })
        .from(documentPhotos)
        .where(eq(documentPhotos.documentId, documentId))
      const taken = total?.value ?? 0
      if (taken >= DOCUMENT_PHOTO_MAX_PER_DOCUMENT) {
        throw errors.validation(
          `К документу загружено ${DOCUMENT_PHOTO_MAX_PER_DOCUMENT} фото — больше нельзя`,
        )
      }
      const fileId = await storeFileBytes(tx, ctx, {
        spaceId: await documentsSpaceId(tx),
        name: `${locked.subject.trim() || 'Фото'} — ${taken + 1}.jpg`,
        mime: 'image/jpeg',
        bytes: clean.bytes,
        checksum,
        attachToObjectId: documentId,
      })
      const [inserted] = await tx
        .insert(documentPhotos)
        .values({
          fileId,
          documentId,
          clientKey: input.clientKey,
          size: clean.bytes.byteLength,
          width: clean.width,
          height: clean.height,
          uploadedBy: ctx.userId,
        })
        .returning()
      if (!inserted) throw errors.internal('Фото не записано')
      return inserted
    })
    return view(row)
  },
}
