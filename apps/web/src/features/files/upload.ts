import type { FileRecord, UploadResume, UploadSession } from '@kchs/contracts'
import { t } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

export interface UploadInput {
  file: File
  spaceId: string
  folderId?: string | null
  /** Новая версия существующего файла. */
  fileId?: string | null
  attachToObjectId?: string | null
  /** Примечание к версии: что изменилось. */
  note?: string | null
  onProgress?: (progress: number) => void
}

interface SessionResponse extends UploadSession {
  fileId: string
  versionId: string
}

/** Загрузка оборвалась, но сессия жива: повтор того же файла продолжит с места обрыва. */
export class UploadInterruptedError extends Error {
  constructor(readonly progress: number) {
    super(t('files.upload.interrupted', { percent: Math.round(progress * 100) }))
    this.name = 'UploadInterruptedError'
  }
}

/** Попытки одной части: обрыв связи на секунды не должен рвать всю загрузку. */
const PART_ATTEMPTS = 3
const RESUME_PREFIX = 'kchs.upload.'

/**
 * Загрузка напрямую в S3 по подписанным URL (09-files.md §2): мелкие файлы одним
 * PUT, крупные — по частям. Часть повторяется трижды с паузой; если связь так и не
 * вернулась, сессия остаётся открытой, и повторная загрузка того же файла в то же
 * место продолжит с первой недокачанной части (ADR-0151).
 */
export async function uploadFile(input: UploadInput): Promise<FileRecord> {
  const resumeKey = resumeKeyOf(input)
  const resumed = await tryResume(resumeKey)
  const session: SessionResponse | UploadResume =
    resumed ??
    (await http.post<SessionResponse>('/files/upload-sessions', {
      name: input.file.name,
      size: input.file.size,
      mime: input.file.type || 'application/octet-stream',
      spaceId: input.spaceId,
      folderId: input.folderId ?? null,
      fileId: input.fileId ?? null,
      attachToObjectId: input.attachToObjectId ?? null,
    }))

  const parts: Array<{ partNumber: number; etag: string }> = []

  if ('singlePutUrl' in session && session.singlePutUrl) {
    try {
      await putWithProgress(session.singlePutUrl, input.file, input.file.type, input.onProgress)
    } catch (error) {
      await http.delete(`/files/upload-sessions/${session.uploadId}`).catch(() => undefined)
      throw error
    }
  } else {
    // Многочастная: сессия запоминается до конца, чтобы после обрыва продолжить
    remember(resumeKey, session.uploadId, session.expiresAt)
    const done = new Map(
      ('uploaded' in session ? session.uploaded : []).map((part) => [part.partNumber, part.etag]),
    )
    let uploaded = 0
    for (const part of session.parts) {
      const etag = done.get(part.partNumber)
      if (etag) {
        parts.push({ partNumber: part.partNumber, etag })
        uploaded += part.size
        input.onProgress?.(Math.min(1, uploaded / input.file.size))
        continue
      }
      const start = (part.partNumber - 1) * session.partSize
      const chunk = input.file.slice(start, start + part.size)
      const partEtag = await putPart(part.url, chunk).catch(() => null)
      if (partEtag === null) throw new UploadInterruptedError(uploaded / input.file.size)
      parts.push({ partNumber: part.partNumber, etag: partEtag })
      uploaded += part.size
      input.onProgress?.(Math.min(1, uploaded / input.file.size))
    }
  }

  input.onProgress?.(1)
  const record = await http.post<FileRecord>(
    `/files/upload-sessions/${session.uploadId}/complete`,
    {
      uploadId: session.uploadId,
      storageKey: session.storageKey,
      parts,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
  )
  forget(resumeKey)
  return record
}

async function putPart(url: string, chunk: Blob): Promise<string> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * 3 ** (attempt - 1)))
    try {
      const response = await fetch(url, { method: 'PUT', body: chunk })
      if (response.ok) return response.headers.get('etag')?.replace(/"/g, '') ?? ''
      lastError = new Error(t('files.upload.httpFailed', { status: response.status }))
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** Сохранённая сессия этого файла: продолжить, если сервер её ещё держит. */
async function tryResume(key: string): Promise<UploadResume | null> {
  const saved = recall(key)
  if (!saved) return null
  try {
    return await http.get<UploadResume>(`/files/upload-sessions/${saved.uploadId}`)
  } catch (error) {
    // Сессия закрыта или истекла — начинаем заново; сетевую ошибку отдаём выше
    if (error instanceof ApiError) {
      forget(key)
      return null
    }
    throw error
  }
}

/** Тот же файл (имя, размер, время изменения) в то же место. */
function resumeKeyOf(input: UploadInput): string {
  const target = input.fileId ?? input.attachToObjectId ?? input.folderId ?? 'root'
  const file = `${input.file.name}:${input.file.size}:${input.file.lastModified}`
  return `${RESUME_PREFIX}${input.spaceId}:${target}:${file}`
}

function recall(key: string): { uploadId: string; expiresAt: string } | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as { uploadId?: string; expiresAt?: string }
    if (!value.uploadId || !value.expiresAt || Date.parse(value.expiresAt) <= Date.now()) {
      localStorage.removeItem(key)
      return null
    }
    return { uploadId: value.uploadId, expiresAt: value.expiresAt }
  } catch {
    return null
  }
}

function remember(key: string, uploadId: string, expiresAt: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ uploadId, expiresAt }))
  } catch {
    // Хранилище браузера недоступно — докачки не будет, загрузка идёт как обычно
  }
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // см. remember
  }
}

function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    if (contentType) request.setRequestHeader('Content-Type', contentType)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total)
    }
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(t('files.upload.httpFailed', { status: request.status })))
    request.onerror = () => reject(new Error(t('files.upload.networkFailed')))
    request.send(file)
  })
}
