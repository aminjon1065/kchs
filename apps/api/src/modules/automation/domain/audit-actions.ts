/**
 * Действия аудита автоматизации (ADR-0182, ADR-0185): файл одного правила —
 * выгрузка конфигурации (17-security.md §6), как выгрузка пакета конфигурации.
 */
export const AUTOMATION_AUDIT = {
  ruleExported: 'automation.rule_exported',
} as const
