import type { SYSTEM_DATASETS } from '@kchs/contracts'
import type { ResolvedDataset } from '@kchs/query'
import type { Ctx } from '~/shared/context.js'

export type SystemDatasetName = (typeof SYSTEM_DATASETS)[number]

/**
 * Системный датасет (06-analytics-engine.md, P1-E04 S05): задачи, документы,
 * встречи как источник запросов. Модуль-владелец описывает представление в
 * схеме `ds` и политику строк смотрящего; компилятор получает их как обычный
 * источник, так что права применяются в одном месте (ADR-0060).
 */
export interface SystemDatasetDefinition {
  name: SystemDatasetName
  /** Источник для компилятора с правами пользователя запроса. */
  resolve: (ctx: Ctx) => Promise<ResolvedDataset>
  /** Поле времени по умолчанию — для показателей над системным датасетом (ADR-0082). */
  timeField?: string
}

const registry = new Map<string, SystemDatasetDefinition>()

export function registerSystemDataset(definition: SystemDatasetDefinition): void {
  if (registry.has(definition.name)) {
    throw new Error(`Системный датасет «${definition.name}» уже зарегистрирован`)
  }
  registry.set(definition.name, definition)
}

export function systemDataset(name: string): SystemDatasetDefinition | undefined {
  return registry.get(name)
}
