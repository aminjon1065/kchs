import type { ObjectType, RuleCatalog, RuleEventHint, RuleObjectTypeHint } from '@kchs/contracts'
import {
  EVENT_PAYLOADS,
  EVENT_TYPES,
  RULE_ACTION_TYPES,
  RULE_EXPRESSION_ROOTS,
} from '@kchs/contracts'
import { listObjectTypes } from '~/kernel/objects/registry.js'
import { ProcessDefinitions } from '~/kernel/process/index.js'
import { processObjectProviders } from '~/kernel/process/registry.js'
import { db } from '~/shared/db/client.js'

/**
 * Справочник конструктора правил (14-automation-integrations.md §1):
 * события каталога с полями полезной нагрузки, типы объектов с полями карточки
 * и опубликованные маршруты для действия `start_process`. Подсказки те же, что
 * у конструктора маршрутов (ADR-0087): один язык — один справочник.
 */

/** Имена полей схемы события: подсказки `event.payload.<поле>`. */
function payloadFields(type: string): string[] {
  const schema = EVENT_PAYLOADS[type as keyof typeof EVENT_PAYLOADS]
  const shape = (schema as unknown as { shape?: Record<string, unknown> })?.shape
  return shape ? Object.keys(shape) : []
}

export function eventHints(): RuleEventHint[] {
  return EVENT_TYPES.map((type) => ({
    type,
    domain: type.split('.')[0] ?? '',
    payloadFields: payloadFields(type),
  }))
}

async function objectTypeHints(): Promise<RuleObjectTypeHint[]> {
  const known = new Set(listObjectTypes().map((definition) => definition.type))
  const hints: RuleObjectTypeHint[] = []
  for (const provider of processObjectProviders()) {
    if (!known.has(provider.objectType as ObjectType)) continue
    const fields = (await provider.fieldHints?.(db())) ?? []
    hints.push({
      type: provider.objectType as ObjectType,
      fields: fields.map((field) => ({
        path: field.path,
        label: field.label,
        type: field.type,
      })),
    })
  }
  return hints
}

export async function ruleCatalog(): Promise<RuleCatalog> {
  const processes: RuleCatalog['processes'] = []
  for (const definition of listObjectTypes()) {
    const published = await ProcessDefinitions.published(db(), definition.type)
    for (const item of published) {
      processes.push({
        key: item.key,
        objectType: definition.type,
        name: item.definition.name,
      })
    }
  }
  return {
    events: eventHints(),
    objectTypes: await objectTypeHints(),
    actions: [...RULE_ACTION_TYPES],
    roots: [...RULE_EXPRESSION_ROOTS],
    processes,
  }
}
