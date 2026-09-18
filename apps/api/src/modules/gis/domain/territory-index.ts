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

  /** Код или название на любом языке → идентификатор; неоднозначное название — `ambiguous`. */
  resolve(value: string): string | 'ambiguous' | null {
    const found = this.keys.get(normalizeName(value))
    if (found === undefined) return null
    return found ?? 'ambiguous'
  }

  label(territory: Territory, locale: Locale): string {
    return territory.name[locale] ?? territory.name.ru
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
