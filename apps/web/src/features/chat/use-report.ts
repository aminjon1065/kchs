import { useToast } from '@kchs/ui'
import { ApiError } from '~/shared/api/errors.js'
import { useT } from '~/shared/i18n.js'

/** Ошибка действия в диалогах бесед — уведомлением: текст ответа API или общий. */
export const useReport = () => {
  const t = useT()
  const toast = useToast()
  return (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
}
