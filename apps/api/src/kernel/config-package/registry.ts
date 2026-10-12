import type { Capability, ConfigItem, ConfigSection } from '@kchs/contracts'
import type { UserCtx } from '~/shared/context.js'

/**
 * Реестр разделов пакета конфигурации (14-automation-integrations.md §6,
 * ADR-0097).
 *
 * Ядро не знает, что лежит в разделе: модуль сам выгружает и применяет свои
 * записи по стабильному ключу. Это та же инверсия зависимости, что и реестр
 * типов объектов, — иначе перенос конфигурации читал бы чужие таблицы.
 */
export interface ConfigSectionProvider {
  section: ConfigSection
  /** Способность, без которой раздел не выгружается и не применяется. */
  capability: Capability
  /** Все записи раздела. */
  list: () => Promise<ConfigItem[]>
  /** Запись по стабильному ключу; `null` — такой здесь нет. */
  find: (key: string) => Promise<ConfigItem | null>
  /** Применяет запись пакета; возвращает, что сделано. */
  apply: (ctx: UserCtx, item: ConfigItem) => Promise<'created' | 'updated'>
  /**
   * Второй проход после всех записей пакета (ADR-0206): ссылки на записи, которые
   * приехали в том же пакете позже, — журнал ссылается на типы документов, а тип —
   * на журнал нумерации.
   */
  relink?: (ctx: UserCtx, item: ConfigItem) => Promise<void>
}

const providers = new Map<ConfigSection, ConfigSectionProvider>()

export function registerConfigSection(provider: ConfigSectionProvider): void {
  providers.set(provider.section, provider)
}

export function configSection(section: ConfigSection): ConfigSectionProvider | undefined {
  return providers.get(section)
}

export function listConfigSections(): ConfigSectionProvider[] {
  return [...providers.values()]
}
