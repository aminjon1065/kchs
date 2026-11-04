import { type AnyColumn, type SQL, sql } from 'drizzle-orm'

/**
 * Та же отметка архива или корзины, что у корня операции: одна транзакция — один
 * now(), но снимок объекта приходит с точностью до миллисекунд, а в базе —
 * микросекунды. По ней восстановление возвращает только то, что ушло вместе с
 * корнем, а удалённое раньше отдельно остаётся в корзине (ADR-0228).
 */
export const sameMoment = (column: AnyColumn, moment: string): SQL =>
  sql`date_trunc('milliseconds', ${column}) = ${moment}::timestamptz`
