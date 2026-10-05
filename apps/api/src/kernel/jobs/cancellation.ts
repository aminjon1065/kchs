import { logger } from '~/shared/logger/index.js'
import { cacheKeys, redis } from '~/shared/redis/index.js'

/** Флаг живёт сутки: дольше задание в очереди не ждёт. */
const CANCEL_TTL_SECONDS = 86_400
/** Как часто выполняющееся задание проверяет флаг отмены, мс. */
const CANCEL_POLL_MS = 2_000

/** Задание отменено — обработчик прерывается по `AbortSignal`. */
export class JobCancelledError extends Error {
  constructor() {
    super('Задание отменено')
    this.name = 'JobCancelledError'
  }
}

/**
 * Отмена задания (ADR-0172): флаг в Redis видят и TS-воркер, и движок — оба
 * проверяют его перед началом задания и раз в несколько секунд во время работы.
 * Флаг, а не сообщение канала: сообщение до процесса, ещё не начавшего задание
 * или переподключающегося к Redis, не доходит.
 */
export async function signalCancel(jobId: string): Promise<void> {
  await redis().set(cacheKeys.jobCancel(jobId), '1', 'EX', CANCEL_TTL_SECONDS)
}

export async function isCancelRequested(jobId: string): Promise<boolean> {
  return (await redis().exists(cacheKeys.jobCancel(jobId))) === 1
}

/**
 * Следить за отменой выполняющегося задания: по флагу контроллер прерывает
 * обработчик. Возвращает функцию, снимающую наблюдение.
 */
export function watchCancellation(
  jobId: string,
  controller: AbortController,
  pollMs = CANCEL_POLL_MS,
): () => void {
  const check = async () => {
    if (controller.signal.aborted) return
    try {
      if (await isCancelRequested(jobId)) controller.abort(new JobCancelledError())
    } catch (error) {
      logger().debug({ err: error, jobId }, 'флаг отмены задания не прочитан')
    }
  }
  void check()
  const timer = setInterval(() => void check(), pollMs)
  return () => clearInterval(timer)
}
