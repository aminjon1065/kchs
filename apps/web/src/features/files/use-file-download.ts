import { useToast } from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { saveLink, waitForRender } from '~/features/documents/index.js'
import { ApiError } from '~/shared/api/errors.js'
import { useT } from '~/shared/i18n.js'
import { filesApi } from './queries.js'

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
        saveLink(await filesApi.getDownload(input.fileId, { versionId: input.versionId }))
        return
      } catch (error) {
        if (!watermarkRequired(error)) throw error
      }
      toast.show({ title: t('files.watermark.preparing') })
      const render = await filesApi.postDocumentsWatermarked({
        fileId: input.fileId,
        // Версия, закреплённая за версией документа (ADR-0197), — её и копируем
        ...(input.versionId ? { versionId: input.versionId } : {}),
      })
      const done = await waitForRender(render.id)
      if (done.status !== 'ready') {
        throw new Error(done.error ?? t('files.watermark.failed'))
      }
      saveLink(await filesApi.getDocumentsRendersDownload(render.id))
    },
    onError: (error) =>
      toast.error(error instanceof Error && error.message ? error.message : t('errors.unknown')),
  })
}
