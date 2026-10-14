import { ApiError } from '~/shared/api/errors.js'
import type { useT } from '~/shared/i18n.js'

/** Ошибка «Спросить данные» — по причине из ответа API, понятными словами (и в ИИ-ячейке тетради). */
export function askError(
  error: unknown,
  t: ReturnType<typeof useT>,
): { title: string; detail: string | null } {
  if (!(error instanceof ApiError)) return { title: t('errors.unknown'), detail: null }
  const data = error.problem.data as { reason?: string; issues?: string[] } | undefined
  switch (data?.reason) {
    case 'ai_not_configured':
      return { title: t('data.ask.errors.notConfigured'), detail: null }
    case 'ai_limit':
      return { title: t('data.ask.errors.limit'), detail: null }
    case 'ai_provider':
      return { title: t('data.ask.errors.provider'), detail: null }
    case 'ai_unanswerable':
      return { title: t('data.ask.errors.unanswerable'), detail: error.message }
    case 'ai_invalid':
      return {
        title: t('data.ask.errors.invalid'),
        detail: data.issues?.slice(0, 3).join('; ') ?? null,
      }
    default:
      if (error.status === 403) return { title: t('data.ask.errors.forbidden'), detail: null }
      return { title: error.message, detail: null }
  }
}
