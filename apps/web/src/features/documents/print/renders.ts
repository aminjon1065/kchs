import type { DocumentRenderRecord, DocumentTemplateRecord, PrintFormInfo } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

const ACTIVE = new Set(['queued', 'running'])

/**
 * Ключи кэша рендеров: формы и рендеры объекта — под `['object', id, …]`,
 * их перечитывает realtime ядра при событиях документа (ADR-0085).
 */
export const renderKeys = {
  forms: (subjectId: string) => ['object', subjectId, 'print-forms'] as const,
  renders: (subjectId: string) => ['object', subjectId, 'renders'] as const,
  templates: (typeId: string | null, includeInactive: boolean) =>
    ['documents', 'templates', typeId ?? 'all', includeInactive] as const,
  compare: (documentId: string, from: string, to: string) =>
    ['object', documentId, 'compare', from, to] as const,
}

export const printFormsQuery = (subjectId: string) =>
  queryOptions({
    queryKey: renderKeys.forms(subjectId),
    queryFn: async () =>
      (
        await http.get<{ items: PrintFormInfo[] }>('/documents/print-forms', {
          query: { subjectId },
        })
      ).items,
    staleTime: 30_000,
  })

/** Печатные формы и заполнения объекта; пока что-то строится — опрос раз в 3 секунды. */
export const rendersQuery = (subjectId: string) =>
  queryOptions({
    queryKey: renderKeys.renders(subjectId),
    queryFn: async () =>
      (
        await http.get<{ items: DocumentRenderRecord[] }>('/documents/renders', {
          query: { subjectId },
        })
      ).items,
    refetchInterval: (query) =>
      query.state.data?.some((render) => ACTIVE.has(render.status)) ? 3000 : false,
  })

export const templatesQuery = (typeId: string | null, includeInactive = false) =>
  queryOptions({
    queryKey: renderKeys.templates(typeId, includeInactive),
    queryFn: async () =>
      (
        await http.get<{ items: DocumentTemplateRecord[] }>('/document-templates', {
          query: {
            typeId: typeId ?? undefined,
            includeInactive: includeInactive ? 'true' : undefined,
          },
        })
      ).items,
    staleTime: 60_000,
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ждёт завершения рендера: движок строит PDF или DOCX за секунды, предел — 3 минуты. */
export async function waitForRender(
  id: string,
  timeoutMs = 180_000,
): Promise<DocumentRenderRecord> {
  const deadline = Date.now() + timeoutMs
  let render = await http.get<DocumentRenderRecord>(`/documents/renders/${id}`)
  while (ACTIVE.has(render.status) && Date.now() < deadline) {
    await sleep(1500)
    render = await http.get<DocumentRenderRecord>(`/documents/renders/${id}`)
  }
  return render
}

/** Скачивание по подписанной ссылке: имя файла задаёт сервер. */
export function saveLink(result: { url: string; name: string }): void {
  const link = window.document.createElement('a')
  link.href = result.url
  link.download = result.name
  link.rel = 'noopener'
  window.document.body.appendChild(link)
  link.click()
  link.remove()
}
