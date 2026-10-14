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
