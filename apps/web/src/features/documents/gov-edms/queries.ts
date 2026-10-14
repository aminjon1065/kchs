import type { GovEdmsTransferInput } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { uploadFile } from '~/entities/files/upload.js'
import { http } from '~/shared/api/client.js'
import { type ImportDocument, sha256Hex } from './import-plan.js'

/** Ручной обмен с госЭДО (ADR-0219): очередь входящих, пакет и отметка исходящего. */
export type GovEdmsScope = 'pending' | 'all'

export const govEdmsKeys = {
  all: ['documents', 'gov-edms'] as const,
  intake: (scope: GovEdmsScope) => ['documents', 'gov-edms', 'intake', scope] as const,
  outgoing: (documentId: string) => ['object', documentId, 'gov-edms'] as const,
}

export const govEdmsIntakePage = (scope: GovEdmsScope, cursor: string | undefined) =>
  http.get('/documents/gov-edms/intake', {
    query: { state: scope, ...(cursor ? { cursor } : {}) },
  })

export const govEdmsOutgoingQuery = (documentId: string) =>
  queryOptions({
    queryKey: govEdmsKeys.outgoing(documentId),
    queryFn: () => http.get('/documents/:id/gov-edms', { params: { id: documentId } }),
  })

/** Какие основные файлы уже заведены: хэш → документ. */
export async function duplicatesOf(
  hashes: string[],
): Promise<Map<string, { id: string; title: string; regNumber: string | null }>> {
  if (hashes.length === 0) return new Map()
  const result = await http.post('/documents/gov-edms/check', { body: { sha256: hashes } })
  return new Map(result.matches.map((match) => [match.sha256, match.document]))
}

/**
 * Один документ из госЭДО: черновик → основной файл и приложения загружаются к нему →
 * версия. Повтор, который сервер узнал по хэшу, — ошибка с номером заведённого документа.
 */
export async function importDocument(document: ImportDocument): Promise<string> {
  const created = await http.post('/documents/gov-edms/intake', {
    body: { subject: document.name.slice(0, 1000) },
  })
  const target = { spaceId: created.spaceId, attachToObjectId: created.documentId }
  const main = await uploadFile({ ...target, file: document.main })
  const attachments = []
  for (const file of document.attachments) attachments.push(await uploadFile({ ...target, file }))
  await http.post('/documents/gov-edms/intake/:id/complete', {
    params: { id: created.documentId },
    body: { mainFileId: main.id, attachmentIds: attachments.map((item) => item.id) },
  })
  return created.documentId
}

export { sha256Hex }

export const govEdmsPackage = (documentId: string) =>
  http.post('/documents/:id/gov-edms/package', { params: { id: documentId } })

export const govEdmsTransferred = (documentId: string, body: GovEdmsTransferInput) =>
  http.post('/documents/:id/gov-edms/transferred', { params: { id: documentId }, body })
