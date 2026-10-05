import { z } from 'zod'
import { RuleCondition } from '../automation/rule.js'
import { FilterNode } from '../common/filter.js'
import { Json } from '../common/primitives.js'

/**
 * Именованные схемы спецификации OpenAPI (ADR-0188). Рекурсивную схему нельзя развернуть на
 * месте: она описывается один раз в `components.schemas`, операции ссылаются на неё по имени.
 * Схема без имени давала ссылку на несуществующий компонент (`schema0`). Новая рекурсивная
 * схема в маршрутах — строка здесь, иначе `pnpm openapi:gen` падает на битой ссылке.
 */
export function openApiComponents(): z.core.$ZodRegistry<{ id?: string }> {
  const components = z.registry<{ id?: string }>()
  components.add(Json, { id: 'Json' })
  components.add(FilterNode, { id: 'FilterNode' })
  components.add(RuleCondition, { id: 'RuleCondition' })
  return components
}
