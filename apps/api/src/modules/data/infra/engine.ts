import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'

/**
 * Синхронный вызов внутреннего маршрута движка с сервисным токеном: анализ
 * файла импорта (ADR-0046), сборка геоформата экспорта (ADR-0068). Ответ 422 —
 * ошибка данных с причиной в `detail`, остальные сбои — зависимость недоступна.
 */
export async function postEngine(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const env = config()
  if (!env.ENGINE_INTERNAL_URL || !env.INTERNAL_SERVICE_TOKEN) {
    throw errors.unavailable('Движок недоступен: не заданы ENGINE_INTERNAL_URL и сервисный токен')
  }
  let response: Response
  try {
    response = await fetch(`${env.ENGINE_INTERNAL_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kchs-service-token': env.INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw errors.dependencyFailed('Движок не ответил', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (response.status === 422) {
    // Движок не смог прочитать файл: это ошибка данных, а не сбой
    const detail = (await response.json().catch(() => ({}))) as { detail?: unknown }
    throw errors.validation(
      typeof detail.detail === 'string' ? detail.detail : 'Файл не удалось прочитать',
    )
  }
  if (!response.ok) {
    throw errors.dependencyFailed('Движок не обработал файл', { status: response.status })
  }
  return response.json()
}
