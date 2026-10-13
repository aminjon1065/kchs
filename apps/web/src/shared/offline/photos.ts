import {
  type DocumentPhoto,
  FORM_PHOTO_MAX_BYTES,
  FORM_PHOTO_MAX_SIDE,
  type FormPhoto,
} from '@kchs/contracts'
import { http } from '~/shared/api/client.js'
import { PHOTOS_STORE, readAll, readOne, remove, write } from './store.js'

/**
 * Снимки сводки на устройстве (ADR-0208). Фото сжимается сразу после съёмки и
 * ложится в IndexedDB под своим ключом; значение поля сводки — этот ключ, пока снимок
 * не ушёл на сервер, и идентификатор файла после. Без сети снимок ждёт вместе со
 * сдачей в очереди (ADR-0204) и уходит перед ней; повтор загрузки с тем же ключом
 * сервер не дублирует. Снимки — по сотруднику, как и очередь.
 */
export interface LocalPhoto {
  /** Ключ снимка устройства — он же значение поля, пока файла на сервере нет. */
  id: string
  userId: string
  fieldKey: string
  blob: Blob
  createdAt: number
  /** Файл на сервере: снимок загружен, а сдача ещё не дошла. */
  fileId: string | null
}

/** Неотправленный снимок старше этого срока уже никому не нужен. */
const STALE_MS = 30 * 86_400_000

/** Размеры кадра, вписанного в квадрат `max`: снимок только уменьшается. */
export function fitWithin(
  width: number,
  height: number,
  max = FORM_PHOTO_MAX_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

export class PhotoFormatError extends Error {}

/**
 * Сжатие на устройстве: длинная сторона до 1600 px, JPEG. Перекодировка через canvas
 * заодно выбрасывает EXIF — с моделью телефона и координатами съёмки: место
 * происшествия форма спрашивает своим полем-точкой (ADR-0157), а не из снимка.
 * Поворот по EXIF браузер применяет сам (`imageOrientation: 'from-image'`).
 */
export async function compressPhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new PhotoFormatError('format')
  }
  const size = fitWithin(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new PhotoFormatError('canvas')
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  bitmap.close()
  for (const quality of [0.82, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (blob && blob.size <= FORM_PHOTO_MAX_BYTES) return blob
  }
  throw new PhotoFormatError('size')
}

export async function saveLocalPhoto(input: {
  userId: string
  fieldKey: string
  blob: Blob
}): Promise<LocalPhoto> {
  const photo: LocalPhoto = {
    id: crypto.randomUUID(),
    userId: input.userId,
    fieldKey: input.fieldKey,
    blob: input.blob,
    createdAt: Date.now(),
    fileId: null,
  }
  await write(PHOTOS_STORE, photo)
  return photo
}

/** Снимок устройства по ключу — только свой. */
export async function localPhoto(id: string, userId: string): Promise<LocalPhoto | null> {
  const photo = await readOne<LocalPhoto>(PHOTOS_STORE, id).catch(() => undefined)
  return photo && photo.userId === userId ? photo : null
}

async function base64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return url.slice(url.indexOf(',') + 1)
}

type Upload = (submissionId: string, photo: LocalPhoto) => Promise<FormPhoto>

const uploadPhoto: Upload = async (submissionId, photo) =>
  http.post('/forms/submissions/:sid/photos', {
    params: { sid: submissionId },
    body: { clientKey: photo.id, fieldKey: photo.fieldKey, data: await base64(photo.blob) },
  })

let upload: Upload = uploadPhoto

/** Подмена загрузки — для тестов очереди. */
export function setPhotoUploader(next: Upload | null): void {
  upload = next ?? uploadPhoto
}

/**
 * Значения сводки с файлами вместо ключей устройства: каждый ещё не загруженный
 * снимок уходит на сервер. Сетевая ошибка пробрасывается — сдача ляжет в очередь
 * с ключами, и очередь повторит загрузку. Возвращает и ключи загруженных снимков:
 * их можно стереть с устройства, когда сдача дойдёт.
 */
export async function resolvePhotos<
  T extends { values: Record<string, unknown>; rows?: Array<Record<string, unknown>> },
>(submissionId: string, userId: string, body: T): Promise<{ body: T; uploaded: string[] }> {
  const uploaded: string[] = []
  const cache = new Map<string, string>()
  const resolve = async (values: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...values }
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue
      const known = cache.get(value)
      if (known) {
        out[key] = known
        continue
      }
      const photo = await localPhoto(value, userId)
      if (!photo) continue
      const fileId = photo.fileId ?? (await upload(submissionId, photo)).id
      if (!photo.fileId) await write(PHOTOS_STORE, { ...photo, fileId })
      cache.set(value, fileId)
      uploaded.push(photo.id)
      out[key] = fileId
    }
    return out
  }
  const values = await resolve(body.values)
  const rows = body.rows ? await Promise.all(body.rows.map((row) => resolve(row))) : undefined
  return { body: { ...body, values, ...(rows ? { rows } : {}) }, uploaded }
}

type DocumentUpload = (documentId: string, photo: LocalPhoto) => Promise<DocumentPhoto>

const uploadToDocument: DocumentUpload = async (documentId, photo) =>
  http.post('/documents/:id/photos', {
    params: { id: documentId },
    body: { clientKey: photo.id, data: await base64(photo.blob) },
  })

let documentUpload: DocumentUpload = uploadToDocument

/** Подмена загрузки в документ — для тестов очереди. */
export function setDocumentPhotoUploader(next: DocumentUpload | null): void {
  documentUpload = next ?? uploadToDocument
}

/**
 * Снимки донесения (ADR-0212) — в черновик документа, каждый под своим ключом: повтор
 * после потерянного ответа возвращает тот же файл. Загруженный снимок помечается на
 * устройстве, чтобы следующий проход очереди его пропустил.
 */
export async function uploadDocumentPhotos(
  documentId: string,
  userId: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    const photo = await localPhoto(id, userId)
    if (!photo || photo.fileId) continue
    const uploaded = await documentUpload(documentId, photo)
    await write(PHOTOS_STORE, { ...photo, fileId: uploaded.id })
  }
}

/** Снимки дошли вместе со сдачей — с устройства их можно стереть. */
export async function forgetPhotos(ids: readonly string[]): Promise<void> {
  for (const id of ids) await remove(PHOTOS_STORE, id).catch(() => undefined)
}

/** Уборка: неотправленные снимки сотрудника старше месяца. */
export async function sweepPhotos(userId: string, now = Date.now()): Promise<void> {
  const all = await readAll<LocalPhoto>(PHOTOS_STORE).catch(() => [])
  for (const photo of all) {
    if (photo.userId === userId && now - photo.createdAt > STALE_MS) {
      await remove(PHOTOS_STORE, photo.id).catch(() => undefined)
    }
  }
}
