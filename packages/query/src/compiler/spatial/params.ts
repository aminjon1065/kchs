import { fail, type IssuePath } from '../../errors.js'
import { type CompileState, MISSING } from '../state.js'
import { NUMERIC } from './defs.js'

/** Параметры шага spatial: чтение с проверкой типа, диапазона и списка допустимых. */
/** Параметры операции: известные ключи, числа (значением или `@param:имя`), строки, списки. */
export class ParamReader {
  constructor(
    private readonly state: CompileState,
    private readonly values: Record<string, unknown>,
    readonly path: IssuePath,
    allowed: readonly string[],
  ) {
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) {
        fail([...path, key], `Неизвестный параметр «${key}»`, {
          hint: `Параметры операции: ${allowed.join(', ')}`,
        })
      }
    }
  }

  at(key: string): IssuePath {
    return [...this.path, key]
  }

  has(key: string): boolean {
    return this.values[key] !== undefined && this.values[key] !== null
  }

  value(key: string): unknown {
    return this.values[key]
  }

  /** Число из диапазона; `@param:имя` — значение параметра запроса. */
  number(
    key: string,
    range: { min: number; max: number; positive?: boolean },
    required: true,
  ): number
  number(key: string, range: { min: number; max: number; positive?: boolean }): number | undefined
  number(
    key: string,
    range: { min: number; max: number; positive?: boolean },
    required = false,
  ): number | undefined {
    let value = this.values[key]
    if (value === undefined || value === null) {
      if (required) fail(this.at(key), `Нужен параметр «${key}»`)
      return undefined
    }
    if (typeof value === 'string' && value.startsWith('@param:')) {
      value = this.param(value.slice('@param:'.length), this.at(key))
    }
    if (typeof value === 'string' && NUMERIC.test(value.trim())) value = Number(value)
    const low = range.positive ? `больше ${range.min}` : `не меньше ${range.min}`
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < range.min ||
      (range.positive && value === range.min) ||
      value > range.max
    ) {
      return fail(this.at(key), `«${key}» — число ${low} и не больше ${range.max}`)
    }
    return value
  }

  integer(key: string, min: number, max: number): number | undefined {
    const value = this.number(key, { min, max })
    if (value !== undefined && !Number.isInteger(value)) {
      fail(this.at(key), `«${key}» — целое число от ${min} до ${max}`)
    }
    return value
  }

  string(key: string): string | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string' || !value || value.length > 160) {
      return fail(this.at(key), `«${key}» — непустая строка`)
    }
    return value
  }

  boolean(key: string): boolean | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'boolean') return fail(this.at(key), `«${key}» — true или false`)
    return value
  }

  choice<T extends string>(key: string, options: readonly T[]): T | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (!(options as readonly unknown[]).includes(value)) {
      return fail(this.at(key), `«${key}» — одно из: ${options.join(', ')}`)
    }
    return value as T
  }

  stringList(key: string): string[] | undefined {
    const value = this.values[key]
    if (value === undefined || value === null) return undefined
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160)
    ) {
      return fail(this.at(key), `«${key}» — список полей`)
    }
    return value as string[]
  }

  private param(name: string, path: IssuePath): unknown {
    const value = this.state.paramValue(name, path)
    if (value === MISSING) fail(path, `Не задан параметр «${name}»`)
    return value
  }
}
