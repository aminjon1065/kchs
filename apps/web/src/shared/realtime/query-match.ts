/**
 * Запрос относится к объекту, если id объекта есть в ключе — отдельным элементом
 * (`['object', id, 'activity']`, `['dataset', id]`, `['layers', 'dataset', id]`)
 * или значением параметров (`['rows', { datasetId: id }]`). Ключи модулей названы
 * по типу объекта (`shared/api/queries.ts`), а id — UUID, поэтому совпадение
 * однозначно и реестр ключей не нужен. Вложенные параметры глубже первого уровня
 * не просматриваются.
 */
export function keyMentions(queryKey: readonly unknown[], id: string): boolean {
  return queryKey.some((part) => {
    if (part === id) return true
    if (part === null || typeof part !== 'object' || Array.isArray(part)) return false
    return Object.values(part).includes(id)
  })
}
