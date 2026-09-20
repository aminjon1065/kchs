/**
 * Реестр возможностей установки (15-admin-operations.md §1): модуль объявляет
 * свою возможность при старте, а ядро решает, отвечать ли её маршрутам и
 * показывать ли её экраны. Выключается только то, от чего не зависят другие
 * модули: иначе выключение оставило бы платформу с оборванными ссылками.
 */
export interface FeatureDefinition {
  /** Ключ настройки `features.<key>` и значение в `/me`. */
  key: string
  titleKey: string
  hintKey: string
  /** Значение по умолчанию: установка приезжает со всем включённым. */
  fallback?: boolean
  /** Теги маршрутов: при выключенной возможности они отвечают «не найдено». */
  tags: string[]
  /** Экраны оболочки, которые прячутся вместе с возможностью. */
  screens?: string[]
  /** Типы объектов возможности: сколько их заведено, видно администратору. */
  objectTypes?: string[]
}

const features = new Map<string, FeatureDefinition>()
/** Тег маршрута → возможность: строится один раз при регистрации. */
const byTag = new Map<string, string>()

export function registerFeature(definition: FeatureDefinition): void {
  features.set(definition.key, definition)
  for (const tag of definition.tags) byTag.set(tag, definition.key)
}

export function listFeatures(): FeatureDefinition[] {
  return [...features.values()]
}

export function getFeature(key: string): FeatureDefinition | undefined {
  return features.get(key)
}

/** Возможность маршрута по его тегам; без тегов маршрут не выключается. */
export function featureOfTags(tags: string[] | undefined): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    const key = byTag.get(tag)
    if (key) return key
  }
  return undefined
}
