/** SQLSTATE: нарушение уникальности. */
export const UNIQUE_VIOLATION = '23505'

/** Код ошибки Postgres (SQLSTATE) — у ошибки драйвера и у обёртки Drizzle (`cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; current && depth < 3; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
