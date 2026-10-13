import { createHash } from 'node:crypto'
import {
  FORM_PHOTO_MAX_BYTES,
  FORM_PHOTO_MAX_PER_SUBMISSION,
  type FormPhoto,
  type FormPhotoUploadInput,
  type FormSubject,
  type FormSubmissionStatus,
} from '@kchs/contracts'
import { and, count, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { LinkService } from '~/kernel/links/service.js'
import { datasetRecord } from '~/modules/data/public.js'
import {
  destroyFiles,
  type FileContentPolicy,
  type FrozenFile,
  storeFileBytes,
} from '~/modules/files/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { formSubmissionPhotos, formSubmissions } from '../schema.js'
import { type FormRow, FormService, subjectsFor } from './form-service.js'
import { cleanJpeg, JpegError } from './jpeg.js'
import { isBlank } from './table-rows.js'

/**
 * Фото сводки (ADR-0208). Поле датасета типа `file` форма спрашивает фотографией:
 * снимок, пережатый устройством в JPEG, сервер очищает от метаданных и кладёт
 * файлом реестра в папку «Вложения» пространства формы, прикреплённым к форме —
 * его видит тот, кто видит сводку (03-access-model.md: вложение видно по объекту).
 * При сдаче файл прикрепляется и к датасету: строку с фото видят по правам датасета.
 * Вошедший в сдачу снимок заморожен: его не заменить и не удалить, как файл
 * подписанной версии документа (ADR-0197).
 */

const OPEN_STATUSES: FormSubmissionStatus[] = ['draft', 'returned']

const FROZEN_PHOTO = 'Фото вошло в сданную сводку — его нельзя заменить или удалить'

type PhotoRow = typeof formSubmissionPhotos.$inferSelect

function view(row: PhotoRow): FormPhoto {
  return {
    id: row.fileId,
    clientKey: row.clientKey,
    fieldKey: row.fieldKey,
    size: row.size,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
  }
}

/** Ключи полей формы, которые она спрашивает фотографией: поля датасета типа `file`. */
export async function photoFieldKeys(form: Pick<FormRow, 'datasetId' | 'definition'>) {
  const dataset = await datasetRecord(form.datasetId)
  const files = new Set(
    dataset.fields.filter((field) => field.type === 'file').map((field) => field.key),
  )
  return form.definition.fields.map((field) => field.key).filter((key) => files.has(key))
}

/** Идентификаторы фото в значениях сводки: одиночной — из значений, табличной — из строк. */
function photoValues(
  keys: readonly string[],
  entries: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const out = new Set<string>()
  for (const values of entries) {
    for (const key of keys) {
      const value = values[key]
      if (isBlank(value)) continue
      if (typeof value !== 'string') throw errors.validation(`Поле «${key}» — фото сводки`)
      out.add(value)
    }
  }
  return [...out]
}

export const PhotoService = {
  /**
   * Загрузка снимка в поле сводки. Повтор с тем же ключом устройства возвращает уже
   * записанный файл — очередь без сети досылает снимок, пока не дойдёт ответ.
   */
  async upload(
    ctx: UserCtx,
    submissionId: string,
    input: FormPhotoUploadInput,
  ): Promise<FormPhoto> {
    const [current] = await db()
      .select()
      .from(formSubmissions)
      .where(eq(formSubmissions.id, submissionId))
      .limit(1)
    if (!current) throw errors.notFound('Отправка')
    await authorize(ctx, 'view', current.formId)
    const form = await FormService.require(db(), current.formId)
    const subject = { kind: current.subjectKind, id: current.subjectId } as FormSubject
    if (
      !subjectsFor(ctx, form).some((item) => item.kind === subject.kind && item.id === subject.id)
    ) {
      throw errors.forbidden('Фото в сводку добавляет только назначенный')
    }
    const [existing] = await db()
      .select()
      .from(formSubmissionPhotos)
      .where(
        and(
          eq(formSubmissionPhotos.submissionId, submissionId),
          eq(formSubmissionPhotos.clientKey, input.clientKey),
        ),
      )
      .limit(1)
    if (existing) return view(existing)
    if (!OPEN_STATUSES.includes(current.status as FormSubmissionStatus)) {
      throw errors.conflict('Сводка уже сдана')
    }
    if (!(await photoFieldKeys(form)).includes(input.fieldKey)) {
      throw errors.validation(`Поле «${input.fieldKey}» не спрашивает фото`)
    }

    const raw = Buffer.from(input.data, 'base64')
    if (raw.byteLength > FORM_PHOTO_MAX_BYTES) {
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
      // Загрузки одной сводки — по очереди: лимит и ключ устройства проверяются под блокировкой
      const [locked] = await tx
        .select({ status: formSubmissions.status })
        .from(formSubmissions)
        .where(eq(formSubmissions.id, submissionId))
        .for('update')
      if (!locked || !OPEN_STATUSES.includes(locked.status as FormSubmissionStatus)) {
        throw errors.conflict('Сводка уже сдана')
      }
      const [again] = await tx
        .select()
        .from(formSubmissionPhotos)
        .where(
          and(
            eq(formSubmissionPhotos.submissionId, submissionId),
            eq(formSubmissionPhotos.clientKey, input.clientKey),
          ),
        )
        .limit(1)
      if (again) return again
      const [total] = await tx
        .select({ value: count() })
        .from(formSubmissionPhotos)
        .where(eq(formSubmissionPhotos.submissionId, submissionId))
      if ((total?.value ?? 0) >= FORM_PHOTO_MAX_PER_SUBMISSION) {
        throw errors.validation(
          `В сводку загружено ${FORM_PHOTO_MAX_PER_SUBMISSION} фото — больше нельзя`,
        )
      }
      const fileId = await storeFileBytes(tx, ctx, {
        spaceId: form.spaceId,
        name: `${form.title} — ${current.periodKey} — ${input.fieldKey}.jpg`,
        mime: 'image/jpeg',
        bytes: clean.bytes,
        checksum,
        attachToObjectId: form.id,
      })
      const [inserted] = await tx
        .insert(formSubmissionPhotos)
        .values({
          fileId,
          submissionId,
          clientKey: input.clientKey,
          fieldKey: input.fieldKey,
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

  /**
   * Значения фото-полей сводки — только снимки, загруженные в эту сводку: чужой
   * файл реестра значением поля не становится.
   */
  async assertValues(
    executor: Executor,
    form: Pick<FormRow, 'datasetId' | 'definition'>,
    submissionId: string,
    entries: ReadonlyArray<Record<string, unknown>>,
  ): Promise<string[]> {
    const keys = await photoFieldKeys(form)
    if (keys.length === 0) return []
    const ids = photoValues(keys, entries)
    if (ids.length === 0) return []
    const known = await executor
      .select({ fileId: formSubmissionPhotos.fileId })
      .from(formSubmissionPhotos)
      .where(
        and(
          eq(formSubmissionPhotos.submissionId, submissionId),
          inArray(
            formSubmissionPhotos.fileId,
            ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
          ),
        ),
      )
    const found = new Set(known.map((row) => row.fileId))
    const missing = ids.find((id) => !found.has(id))
    if (missing) throw errors.validation('Фото сводки не найдено — загрузите снимок заново')
    return ids
  },

  /**
   * Сдача в транзакции сводки: вошедшие снимки помечаются сданными и прикрепляются
   * к датасету; снимки черновика, которые так и не вошли ни в одну сдачу, уходят
   * насовсем — замена фото в черновике не копит файлы.
   */
  async submitted(
    tx: Tx,
    ctx: UserCtx,
    form: Pick<FormRow, 'datasetId'>,
    submissionId: string,
    fileIds: readonly string[],
  ): Promise<void> {
    if (fileIds.length > 0) {
      await tx
        .update(formSubmissionPhotos)
        .set({ submitted: true })
        .where(
          and(
            eq(formSubmissionPhotos.submissionId, submissionId),
            inArray(formSubmissionPhotos.fileId, [...fileIds]),
          ),
        )
      for (const fileId of fileIds) {
        await LinkService.link(tx, ctx, form.datasetId, fileId, 'attachment')
      }
    }
    const stale = await tx
      .select({ fileId: formSubmissionPhotos.fileId })
      .from(formSubmissionPhotos)
      .where(
        and(
          eq(formSubmissionPhotos.submissionId, submissionId),
          eq(formSubmissionPhotos.submitted, false),
          fileIds.length > 0 ? notInArray(formSubmissionPhotos.fileId, [...fileIds]) : sql`true`,
        ),
      )
    if (stale.length > 0) {
      await destroyFiles(
        tx,
        ctx,
        stale.map((row) => row.fileId),
      )
    }
  },
}

/**
 * Политика содержимого (ADR-0197): снимок сданной сводки не меняется и не удаляется —
 * ни новой версией, ни корзиной, ни редактором. Хозяин — форма.
 */
export const formPhotoPolicy: FileContentPolicy = {
  key: 'forms.photos',
  frozen: async (executor, fileIds) => {
    const rows = await executor
      .select({ fileId: formSubmissionPhotos.fileId, formId: formSubmissions.formId })
      .from(formSubmissionPhotos)
      .innerJoin(formSubmissions, eq(formSubmissions.id, formSubmissionPhotos.submissionId))
      .where(
        and(
          inArray(formSubmissionPhotos.fileId, fileIds),
          eq(formSubmissionPhotos.submitted, true),
        ),
      )
    return new Map<string, FrozenFile>(
      rows.map((row) => [
        row.fileId,
        { reason: 'form_photo', hostId: row.formId, message: FROZEN_PHOTO },
      ]),
    )
  },
}
