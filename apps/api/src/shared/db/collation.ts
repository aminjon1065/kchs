import { type SQL, type SQLWrapper, sql } from 'drizzle-orm'

/**
 * Человеческий порядок строк (ADR-0229): ICU-коллация `kchs_natural` (таджикская, числа по
 * значению) — Ғ после Г, Ҷ после Ч, «Ёров» рядом с «Ершовым», «№ 10» после «№ 2». База
 * создана с C.UTF-8, поэтому порядок задаётся в ORDER BY, а не у столбца: столбцы входят в
 * представления системных датасетов. Только для сортировки — равенство и поиск не меняются.
 */
export function natural(value: SQLWrapper): SQL {
  return sql`(${value}) COLLATE "kchs_natural"`
}
