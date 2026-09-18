import type { Dialect } from './dialect.js'

/**
 * Параметры запроса: каждое значение пользователя — отдельный `$n`, в текст SQL
 * не попадает (правило 5 CLAUDE.md). Значения контекста («сейчас», пояс,
 * пользователь) связываются один раз и переиспользуются по ключу.
 */
export class ParamBinder {
  readonly values: unknown[] = []
  private readonly shared = new Map<string, { sql: string; index: number }>()

  constructor(private readonly dialect: Dialect) {}

  /** Новый параметр; `cast` — SQL-тип, если контекст не определяет тип сам. */
  add(value: unknown, cast?: string): string {
    this.values.push(value)
    const placeholder = this.dialect.placeholder(this.values.length)
    return cast ? this.dialect.cast(placeholder, cast) : placeholder
  }

  /** Параметр, общий для всего запроса (один `$n` на ключ и тип). */
  once(key: string, value: unknown, cast?: string): string {
    const cacheKey = `${key}::${cast ?? ''}`
    const existing = this.shared.get(cacheKey)
    if (existing) return existing.sql
    const sql = this.add(value, cast)
    this.shared.set(cacheKey, { sql, index: this.values.length })
    return sql
  }

  /** Отметка для отката: параметры, добавленные после неё, можно снять. */
  mark(): number {
    return this.values.length
  }

  /**
   * Снимает параметры после отметки — когда скомпилированная часть запроса
   * отброшена (группа условий с незаданным параметром). Иначе в запросе
   * остались бы параметры без `$n` в тексте, и Postgres отверг бы запрос.
   */
  rollback(mark: number): void {
    if (this.values.length <= mark) return
    this.values.length = mark
    for (const [key, entry] of this.shared) {
      if (entry.index > mark) this.shared.delete(key)
    }
  }
}
