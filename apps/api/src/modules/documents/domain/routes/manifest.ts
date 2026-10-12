import { createHash } from 'node:crypto'
import type { DocumentManifest, DocumentManifestFile } from '@kchs/contracts'

/**
 * Канонический JSON (ADR-0198): ключи объектов по алфавиту, без пробелов, UTF-8.
 * Тот же текст получит любой, кто проверяет хэш подписи вне системы.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

export function manifestHash(manifest: DocumentManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')
}

/**
 * Манифест версии — когда движок прислал хэши всех её файлов: основного,
 * приложений и PDF-представления (у PDF-основы представление — сам файл).
 * Нет хэша хоть одного файла — манифеста нет, подпись остаётся по прежнему
 * правилу (хэш основного файла).
 */
export function buildManifest(version: {
  documentId: string
  number: number
  mainFileId: string | null
  pdfFileId: string | null
  attachments: string[]
  fileVersions: Record<string, string>
  hashes: Record<string, string>
}): DocumentManifest | null {
  const file = (fileId: string): DocumentManifestFile | null => {
    const sha256 = version.hashes[fileId]
    if (!sha256) return null
    return { fileId, fileVersionId: version.fileVersions[fileId] ?? null, sha256 }
  }
  if (!version.mainFileId) return null
  const mainFile = file(version.mainFileId)
  if (!mainFile) return null
  const attachments: DocumentManifestFile[] = []
  for (const id of version.attachments) {
    const entry = file(id)
    if (!entry) return null
    attachments.push(entry)
  }
  let pdf: DocumentManifestFile | null = null
  if (version.pdfFileId) {
    pdf = version.pdfFileId === version.mainFileId ? mainFile : file(version.pdfFileId)
    if (!pdf) return null
  }
  return {
    v: 1,
    documentId: version.documentId,
    versionNumber: version.number,
    mainFile,
    attachments,
    pdf,
  }
}
