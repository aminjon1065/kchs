import type { QueryIssue } from '@kchs/contracts'

export type IssuePath = ReadonlyArray<string | number>

/**
 * Ошибка компиляции запроса: путь в спецификации, для выражений — позиция и
 * подсказка (contracts/query-spec.md: «ошибки с путём в спецификации»).
 */
export class QueryCompileError extends Error {
  readonly issues: QueryIssue[]

  constructor(issues: QueryIssue[]) {
    super(issues.map((issue) => issue.message).join('; '))
    this.name = 'QueryCompileError'
    this.issues = issues
  }
}

export interface IssueDetails {
  position?: number
  hint?: string
}

/** Бросает ошибку компиляции с одной проблемой. */
export function fail(path: IssuePath, message: string, details: IssueDetails = {}): never {
  const issue: QueryIssue = { path: [...path], message }
  if (details.position !== undefined) issue.position = details.position
  if (details.hint !== undefined) issue.hint = details.hint
  throw new QueryCompileError([issue])
}

/**
 * Ошибка в выражении: позиция известна, путь добавляет вызывающий
 * (выражение не знает, в каком шаге спецификации оно записано).
 */
export class ExpressionError extends Error {
  readonly position: number
  readonly hint: string | undefined

  constructor(message: string, position: number, hint?: string) {
    super(message)
    this.name = 'ExpressionError'
    this.position = position
    this.hint = hint
  }
}

/** Переводит ошибку выражения в ошибку компиляции с путём. */
export function atPath<T>(path: IssuePath, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof ExpressionError) {
      fail(path, error.message, {
        position: error.position,
        ...(error.hint ? { hint: error.hint } : {}),
      })
    }
    throw error
  }
}
