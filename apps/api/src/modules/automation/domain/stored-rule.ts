import { RuleDefinition, type RuleTriggerKind } from '@kchs/contracts'
import { logger } from '~/shared/logger/index.js'
import type { RuleRow } from './rule-service.js'
import { RuleRuns } from './runs.js'

/** Причина пропуска правила, чьё определение не проходит текущую схему. */
export const BROKEN_DEFINITION =
  'Определение правила не проходит проверку — правило пропущено, откройте и сохраните его заново'

/**
 * Сохранённое определение правила (ADR-0228). Схему ужесточили, а правило пришло из
 * пакета конфигурации или старой версии — определение не разбирается. Тогда это одно
 * правило пропускается с записью в своём журнале (не чаще раза в минуту), а остальные
 * работают: исключение в цикле по правилам останавливало бы всю автоматизацию.
 */
export async function storedDefinition(
  rule: RuleRow,
  triggerKind: RuleTriggerKind,
): Promise<RuleDefinition | null> {
  const parsed = RuleDefinition.safeParse(rule.definition)
  if (parsed.success) return parsed.data
  logger().warn(
    { ruleId: rule.id, issues: parsed.error.issues.slice(0, 5) },
    'определение правила не проходит проверку — правило пропущено',
  )
  await RuleRuns.recordSkip(rule.id, { triggerKind, reason: BROKEN_DEFINITION })
  return null
}
