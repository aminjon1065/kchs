import type { DocumentRenderRecord } from '@kchs/contracts'
import { useToast } from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { useT } from '~/app/i18n.js'
import { saveLink, waitForRender } from '~/features/documents/print/renders.js'
import { ApiError, http } from '~/shared/api/client.js'

function watermarkRequired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.problem.data?.reason === 'watermark_required'
  )
}

/**
 * Скачивание файла (09-files.md §2). Файл с грифом от «конфиденциально» сервер
 * отдаёт только копией с водяным знаком (08-documents.md §13, ADR-0085): тогда
 * заказывается копия, её строит движок, по готовности она скачивается.
 */
export function useFileDownload() {
  const t = useT()
  const toast = useToast()
  return useMutation({
    mutationFn: async (input: { fileId: string; versionId?: string }) => {
      try {
        saveLink(
          await http.get<{ url: string; name: string }>(`/files/${input.fileId}/download`, {
            query: { versionId: input.versionId },
          }),
        )
        return
      } catch (error) {
        if (!watermarkRequired(error)) throw error
      }
      toast.show({ title: t('files.watermark.preparing') })
      const render = await http.post<DocumentRenderRecord>('/documents/watermarked', {
        fileId: input.fileId,
      })
      const done = await waitForRender(render.id)
      if (done.status !== 'ready') {
        throw new Error(done.error ?? t('files.watermark.failed'))
      }
      saveLink(
        await http.get<{ url: string; name: string }>(`/documents/renders/${render.id}/download`),
      )
    },
    onError: (error) =>
      toast.error(error instanceof Error && error.message ? error.message : t('errors.unknown')),
  })
}
