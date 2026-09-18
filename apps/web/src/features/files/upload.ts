import type { FileRecord, UploadSession } from '@kchs/contracts'
import { http } from '~/shared/api/client.js'

export interface UploadInput {
  file: File
  spaceId: string
  folderId?: string | null
  /** Новая версия существующего файла. */
  fileId?: string | null
  attachToObjectId?: string | null
  onProgress?: (progress: number) => void
}

interface SessionResponse extends UploadSession {
  fileId: string
  versionId: string
}

/**
 * Загрузка напрямую в S3 по подписанным URL (09-files.md §2):
 * мелкие файлы одним PUT, крупные — multipart с докачкой по частям.
 */
export async function uploadFile(input: UploadInput): Promise<FileRecord> {
  const session = await http.post<SessionResponse>('/files/upload-sessions', {
    name: input.file.name,
    size: input.file.size,
    mime: input.file.type || 'application/octet-stream',
    spaceId: input.spaceId,
    folderId: input.folderId ?? null,
    fileId: input.fileId ?? null,
    attachToObjectId: input.attachToObjectId ?? null,
  })

  const parts: Array<{ partNumber: number; etag: string }> = []

  try {
    if (session.singlePutUrl) {
      await putWithProgress(session.singlePutUrl, input.file, input.file.type, input.onProgress)
    } else {
      let uploaded = 0
      for (const part of session.parts) {
        const start = (part.partNumber - 1) * session.partSize
        const chunk = input.file.slice(start, start + part.size)
        const response = await fetch(part.url, { method: 'PUT', body: chunk })
        if (!response.ok) throw new Error(`Часть ${part.partNumber} не загрузилась`)
        const etag = response.headers.get('etag')?.replace(/"/g, '') ?? ''
        parts.push({ partNumber: part.partNumber, etag })
        uploaded += part.size
        input.onProgress?.(Math.min(1, uploaded / input.file.size))
      }
    }
  } catch (error) {
    await http.delete(`/files/upload-sessions/${session.uploadId}`).catch(() => undefined)
    throw error
  }

  input.onProgress?.(1)
  return http.post<FileRecord>(`/files/upload-sessions/${session.uploadId}/complete`, {
    uploadId: session.uploadId,
    storageKey: session.storageKey,
    parts,
  })
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
        : reject(new Error(`Загрузка не выполнена: ${request.status}`))
    request.onerror = () => reject(new Error('Сеть недоступна'))
    request.send(file)
  })
}
