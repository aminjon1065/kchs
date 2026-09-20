import type { ConfigItem } from '@kchs/contracts'
import { ProcessDefinition as ProcessDefinitionSchema } from '@kchs/process'
import { desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { processDefinitions } from '~/shared/db/schema/index.js'
import { registerConfigSection } from '../config-package/registry.js'
import { DefinitionService } from './definitions.js'

/**
 * Маршруты в пакете конфигурации (ADR-0097). Определение маршрута уже описано
 * стабильными ключами (`key` определения, ключи шагов, выражения по полям),
 * поэтому переносится как есть: импорт заводит маршрут или публикует новую
 * версию, идущие экземпляры остаются на своей версии (ADR-0079).
 */
function toItem(row: {
  key: string
  objectType: string
  definition: unknown
  updatedAt: string
}): ConfigItem {
  const definition = ProcessDefinitionSchema.parse(row.definition)
  return {
    section: 'processDefinitions',
    key: row.key,
    title: definition.name.ru,
    updatedAt: row.updatedAt,
    data: { objectType: row.objectType, definition },
  }
}

const SELECTION = {
  key: processDefinitions.key,
  objectType: processDefinitions.objectType,
  definition: processDefinitions.definition,
  updatedAt: processDefinitions.updatedAt,
}

export function registerProcessConfigSection(): void {
  registerConfigSection({
    section: 'processDefinitions',
    capability: 'processes.manage',
    list: async () => {
      // Выгружается только опубликованная версия: черновик — незаконченная правка
      const rows = await db()
        .select(SELECTION)
        .from(processDefinitions)
        .where(isNotNull(processDefinitions.publishedAt))
        .orderBy(processDefinitions.key, desc(processDefinitions.version))
      const seen = new Set<string>()
      const items: ConfigItem[] = []
      for (const row of rows) {
        if (seen.has(row.key)) continue
        seen.add(row.key)
        items.push(toItem(row))
      }
      return items
    },
    find: async (key) => {
      const rows = await db()
        .select(SELECTION)
        .from(processDefinitions)
        .where(eq(processDefinitions.key, key))
        .orderBy(desc(processDefinitions.version))
        .limit(1)
      const row = rows[0]
      return row ? toItem(row) : null
    },
    apply: async (ctx, item) => {
      const definition = item.data.definition
      return db().transaction(async (tx) => {
        const created = await DefinitionService.ensurePublished(tx, ctx, definition)
        if (created) return 'created'
        await DefinitionService.saveDraft(tx, ctx, item.key, definition)
        await DefinitionService.publish(tx, ctx, item.key)
        return 'updated'
      })
    },
  })
}
