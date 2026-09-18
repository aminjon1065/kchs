import type { QuerySource, QuerySpec } from '@kchs/contracts'
import type { CollectedSources } from './types.js'

const MAX_DEPTH = 4

/**
 * Источники спецификации (основной, соединения, объединения), которые
 * вызывающий загружает с политиками до компиляции. Сохранённые запросы из
 * `queries` обходятся рекурсивно; не загруженные — только перечисляются.
 */
export function collectSources(
  spec: QuerySpec,
  queries?: ReadonlyMap<string, QuerySpec>,
): CollectedSources {
  const datasets = new Set<string>()
  const saved = new Set<string>()
  const system = new Set<string>()
  let sql = false
  const visit = (current: QuerySpec, depth: number) => {
    const sources: QuerySource[] = [current.source]
    for (const step of current.steps ?? []) {
      if (step.type === 'join' || step.type === 'union') sources.push(step.source)
    }
    for (const source of sources) {
      switch (source.kind) {
        case 'dataset':
          datasets.add(source.id)
          break
        case 'system':
          system.add(source.name)
          break
        case 'sql':
          sql = true
          break
        case 'query': {
          if (saved.has(source.id)) break
          saved.add(source.id)
          const nested = queries?.get(source.id)
          if (nested && depth < MAX_DEPTH) visit(nested, depth + 1)
          break
        }
        case 'inline':
          break
      }
    }
  }
  visit(spec, 0)
  return { datasets: [...datasets], queries: [...saved], system: [...system], sql }
}
