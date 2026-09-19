import type { VersionCompareQuery, VersionCompareResult } from '@kchs/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { fileText } from '~/modules/files/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documentVersions } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { diffText } from './diff.js'

/** Сравнивается начало текста версии: длиннее — это уже не правка письма, а другой документ. */
const TEXT_LIMIT = 300_000
const PENDING = new Set(['queued', 'processing'])

type TextState =
  | { state: 'ready'; text: string; truncated: boolean }
  | { state: 'pending' }
  | { state: 'unavailable' }

/** Текст версии: основного файла, а если его нет — PDF-представления. */
async function versionText(version: {
  mainFileId: string | null
  pdfFileId: string | null
}): Promise<TextState> {
  let pending = false
  for (const fileId of [version.mainFileId, version.pdfFileId]) {
    if (!fileId) continue
    const text = await fileText(fileId, TEXT_LIMIT)
    if (text.status === 'ready' && text.text !== null) {
      return { state: 'ready', text: text.text, truncated: text.truncated }
    }
    if (PENDING.has(text.status)) pending = true
  }
  return pending ? { state: 'pending' } : { state: 'unavailable' }
}

/**
 * Сравнение двух версий документа (08-documents.md §8, ADR-0085): по словам,
 * из текста, извлечённого движком при обработке файлов. Визуальное сравнение
 * (PDF рядом) интерфейс строит из списка версий.
 */
export async function compareVersions(
  ctx: UserCtx,
  documentId: string,
  query: VersionCompareQuery,
): Promise<VersionCompareResult> {
  await authorize(ctx, 'view', documentId)
  const rows = await db()
    .select({
      id: documentVersions.id,
      number: documentVersions.number,
      mainFileId: documentVersions.mainFileId,
      pdfFileId: documentVersions.pdfFileId,
    })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        inArray(documentVersions.id, [query.from, query.to]),
      ),
    )
  const from = rows.find((row) => row.id === query.from)
  const to = rows.find((row) => row.id === query.to)
  if (!from || !to) throw errors.notFound('Версия')
  const base = {
    from: { id: from.id, number: from.number },
    to: { id: to.id, number: to.number },
  }
  const empty = { segments: [], stats: { inserted: 0, deleted: 0, unchanged: 0 } }
  const [a, b] = await Promise.all([versionText(from), versionText(to)])
  if (a.state === 'pending' || b.state === 'pending') {
    return { ...base, status: 'pending', ...empty, truncated: false }
  }
  if (a.state !== 'ready' || b.state !== 'ready') {
    return { ...base, status: 'unavailable', ...empty, truncated: false }
  }
  const diff = diffText(a.text, b.text)
  return { ...base, status: 'ready', ...diff, truncated: a.truncated || b.truncated }
}
