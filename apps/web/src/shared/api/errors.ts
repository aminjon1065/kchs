import type { ProblemDetails } from '@kchs/contracts'

/**
 * Ошибка ответа API — проблема RFC 9457. Отдельно от транспорта (`client.ts`): разбирать
 * ошибку нужно и компоненту, а вызывать API компонент не должен (ADR-0183).
 */
export class ApiError extends Error {
  readonly status: number
  readonly problem: ProblemDetails

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.problem = problem
  }

  get code(): string {
    return this.problem.code
  }

  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const item of this.problem.errors ?? []) result[item.path] = item.message
    return result
  }
}

/**
 * Сохранение поверх чужой правки (ADR-0228): сервер отвечает 412
 * `precondition_failed`, когда версия объекта уже не та, с которой открыт редактор.
 */
export function staleVersion(error: unknown): boolean {
  return error instanceof ApiError && error.status === 412 && error.code === 'precondition_failed'
}
