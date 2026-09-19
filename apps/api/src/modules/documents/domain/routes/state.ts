import type { DocumentRouteBlocker, DocumentRouteBrief, DocumentStatus } from '@kchs/contracts'
import { ProcessView } from '~/kernel/process/index.js'
import type { Executor } from '~/shared/db/client.js'

/** Статусы, из которых документ отправляют по маршруту (08-documents.md §3). */
export const ROUTE_START_STATUSES: readonly DocumentStatus[] = ['draft', 'returned']

/** Документ на согласовании или подписи: версия заморожена, новая — после возврата. */
export const ROUTE_ACTIVE_STATUSES: readonly DocumentStatus[] = ['on_approval', 'on_signing']

/** Почему маршрут сейчас не запустить; null — можно. */
export function routeBlocker(input: {
  canEdit: boolean
  status: DocumentStatus
  running: boolean
  hasVersion: boolean
}): DocumentRouteBlocker | null {
  if (!input.canEdit) return 'access'
  if (input.running) return 'running'
  if (!ROUTE_START_STATUSES.includes(input.status)) return 'status'
  if (!input.hasVersion) return 'no_version'
  return null
}

/** Идущий маршрут документа — текущие шаги для шапки карточки. */
export async function activeRoute(
  executor: Executor,
  documentId: string,
): Promise<DocumentRouteBrief | null> {
  const [route] = await ProcessView.active(executor, documentId)
  return route ?? null
}
