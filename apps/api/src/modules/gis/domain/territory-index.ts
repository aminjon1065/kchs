import type { Locale, Territory, TerritoryLevel } from '@kchs/contracts'
import { TerritoryService } from './territory-service.js'

/** Название для сопоставления: без регистра, «ё» как «е», пробелы схлопнуты. */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
}

/**
 * Справочник территорий в памяти процесса: иерархия, коды и названия. Им
 * пользуются компилятор запросов (`within`, `territory_level`, `territory_name`),
 * импорт (код или название → территория) и проверка значений полей.
 */
export class TerritoryIndex {
  readonly byId = new Map<string, Territory>()
  readonly byCode = new Map<string, Territory>()
  private readonly children = new Map<string, string[]>()
  /** Код или название → идентификатор; null — название неоднозначно. */
  private readonly keys = new Map<string, string | null>()

  constructor(
    readonly version: string,
    readonly items: readonly Territory[],
  ) {
    for (const item of items) {
      this.byId.set(item.id, item)
      this.byCode.set(item.code, item)
      if (item.parentId) {
        const list = this.children.get(item.parentId) ?? []
        list.push(item.id)
        this.children.set(item.parentId, list)
      }
    }
    // Коды точнее названий: код никогда не уступает одноимённому названию
    for (const item of items) {
      for (const name of [item.name.ru, item.name.tg, item.name.en]) {
        if (!name) continue
        const key = normalizeName(name)
        const found = this.keys.get(key)
        if (found === undefined) this.keys.set(key, item.id)
        else if (found !== item.id) this.keys.set(key, null)
      }
    }
    for (const item of items) this.keys.set(normalizeName(item.code), item.id)
  }

  /** Территория и все вложенные (для `within` с дочерними). */
  descendants(id: string): string[] {
    const result: string[] = []
    const stack = [id]
    while (stack.length > 0) {
      const current = stack.pop() as string
      result.push(current)
      stack.push(...(this.children.get(current) ?? []))
    }
    return result
  }

  /** Предок заданного уровня (сама территория, если её уровень такой); нет — null. */
  ancestorAt(id: string, level: TerritoryLevel): Territory | null {
    let current = this.byId.get(id)
    while (current) {
      if (current.level === level) return current
      current = current.parentId ? this.byId.get(current.parentId) : undefined
    }
    return null
  }

  /**
   * Таблица сопоставления для импорта движком: ключ (`normalizeName` кода,
   * названия или идентификатора) → идентификатор; `''` — название неоднозначно.
   */
  matchTable(): Record<string, string> {
    const table: Record<string, string> = {}
    for (const [key, id] of this.keys) table[key] = id ?? ''
    for (const item of this.items) table[normalizeName(item.id)] = item.id
    return table
  }

  /** Код или название на любом языке → идентификатор; неоднозначное название — `ambiguous`. */
  resolve(value: string): string | 'ambiguous' | null {
    const found = this.keys.get(normalizeName(value))
    if (found === undefined) return null
    return found ?? 'ambiguous'
  }

  label(territory: Territory, locale: Locale): string {
    return territory.name[locale] ?? territory.name.ru
  }

  private readonly maps = new Map<string, Readonly<Record<string, string>>>()

  private memo(key: string, build: () => Record<string, string>): Readonly<Record<string, string>> {
    let map = this.maps.get(key)
    if (!map) {
      map = build()
      this.maps.set(key, map)
    }
    return map
  }

  /**
   * Подстановка для `territory_level()`: территория (идентификатор или код) →
   * её предок уровня `level` в том же виде; у кого предка такого уровня нет — нет и ключа.
   */
  ancestorMap(level: TerritoryLevel, key: 'id' | 'code'): Readonly<Record<string, string>> {
    return this.memo(`level:${level}:${key}`, () => {
      const map: Record<string, string> = {}
      for (const item of this.items) {
        const ancestor = this.ancestorAt(item.id, level)
        if (ancestor) map[item[key]] = ancestor[key]
      }
      return map
    })
  }

  /** Подстановка для `territory_name()`: идентификатор или код → название на языке. */
  nameMap(key: 'id' | 'code', locale: Locale): Readonly<Record<string, string>> {
    return this.memo(`name:${key}:${locale}`, () => {
      const map: Record<string, string> = {}
      for (const item of this.items) map[item[key]] = this.label(item, locale)
      return map
    })
  }
}

let cached: TerritoryIndex | null = null

/** Индекс текущей версии справочника: перечитывается, когда версия меняется. */
export async function territoryIndex(): Promise<TerritoryIndex> {
  const version = await TerritoryService.version()
  if (cached?.version === version) return cached
  cached = new TerritoryIndex(version, await TerritoryService.list())
  return cached
}
