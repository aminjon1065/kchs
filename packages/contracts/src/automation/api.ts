import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { LangText, Slug, Timestamp, Uuid } from '../common/primitives.js'
import { ObjectType } from '../objects/object.js'
import { RuleActionType, RuleBranch, RuleDefinition, RuleTriggerKind } from './rule.js'

/** API правил автоматизации и журнала запусков (14-automation-integrations.md §1). */

export const RuleCreateInput = z.object({
  spaceId: Uuid,
  /** Стабильный ключ для экспорта конфигурации; по умолчанию — из названия. */
  key: Slug.optional(),
  definition: RuleDefinition,
})
export type RuleCreateInput = z.infer<typeof RuleCreateInput>

export const RuleUpdateInput = z.object({ definition: RuleDefinition })
export type RuleUpdateInput = z.infer<typeof RuleUpdateInput>

export const RuleEnabledInput = z.object({ enabled: z.boolean() })
export type RuleEnabledInput = z.infer<typeof RuleEnabledInput>

/** Сводка запусков правила за сутки — колонка «Здоровье» в списке. */
export const RuleStats = z.object({
  runs: z.number().int(),
  failures: z.number().int(),
  skipped: z.number().int(),
  lastRunAt: Timestamp.nullable(),
  lastStatus: z.string().nullable(),
})
export type RuleStats = z.infer<typeof RuleStats>

export const RuleListItem = z.object({
  id: Uuid,
  key: z.string(),
  spaceId: Uuid.nullable(),
  spaceName: z.string().nullable(),
  name: LangText,
  description: z.string().nullable(),
  enabled: z.boolean(),
  triggerKind: RuleTriggerKind,
  /** Тип события, выражение cron или ключ вызова — одной строкой для списка. */
  triggerSummary: z.string(),
  actionTypes: z.array(RuleActionType),
  runAs: UserRef.nullable(),
  ownerId: Uuid.nullable(),
  stats: RuleStats,
  nextRunAt: Timestamp.nullable(),
  updatedAt: Timestamp,
})
export type RuleListItem = z.infer<typeof RuleListItem>

export const RuleRecord = RuleListItem.extend({
  definition: RuleDefinition,
  /** Адрес входящего вызова для триггера `webhook`; иначе `null`. */
  webhookUrl: z.string().nullable(),
  canManage: z.boolean(),
})
export type RuleRecord = z.infer<typeof RuleRecord>

export const RuleListQuery = z.object({
  spaceId: Uuid.optional(),
  triggerKind: RuleTriggerKind.optional(),
  enabled: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type RuleListQuery = z.infer<typeof RuleListQuery>

export const RuleList = z.object({ items: z.array(RuleListItem), total: z.number().int() })
export type RuleList = z.infer<typeof RuleList>

// ── Журнал запусков ─────────────────────────────────────────────────────────

export const RULE_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
] as const
export const RuleRunStatus = z.enum(RULE_RUN_STATUSES)
export type RuleRunStatus = z.infer<typeof RuleRunStatus>

export const RuleRunStep = z.object({
  index: z.number().int(),
  action: RuleActionType,
  status: z.enum(['ok', 'skipped', 'failed']),
  /** Что сделано или почему пропущено — диагностика в истории. */
  message: z.string().nullable(),
  objectId: Uuid.nullable(),
  durationMs: z.number().int(),
  at: Timestamp,
  /** Ветка действия; у записей до ADR-0163 её нет — это «то». */
  branch: RuleBranch.optional(),
})
export type RuleRunStep = z.infer<typeof RuleRunStep>

export const RuleRunRecord = z.object({
  id: Uuid,
  ruleId: Uuid,
  ruleName: LangText.nullable(),
  status: RuleRunStatus,
  triggerKind: RuleTriggerKind,
  eventId: z.string().nullable(),
  eventType: z.string().nullable(),
  objectId: Uuid.nullable(),
  objectTitle: z.string().nullable(),
  runAs: UserRef.nullable(),
  /** Глубина каузальной цепочки: сколько правил сработало до этого. */
  depth: z.number().int(),
  steps: z.array(RuleRunStep),
  error: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type RuleRunRecord = z.infer<typeof RuleRunRecord>

export const RuleRunListQuery = z.object({
  status: RuleRunStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
})
export type RuleRunListQuery = z.infer<typeof RuleRunListQuery>

export const RuleRunList = z.object({ items: z.array(RuleRunRecord), total: z.number().int() })
export type RuleRunList = z.infer<typeof RuleRunList>

// ── Тестовый прогон «что бы произошло» ──────────────────────────────────────

export const RuleDryRunInput = z.object({
  /** Проверяемое определение: правило можно испытать до сохранения. */
  definition: RuleDefinition,
  limit: z.number().int().min(1).max(50).default(10),
})
export type RuleDryRunInput = z.infer<typeof RuleDryRunInput>

export const RuleDryRunAction = z.object({
  action: RuleActionType,
  /** Что бы сделало правило — с подставленными значениями шаблонов. */
  summary: z.string(),
  problem: z.string().nullable(),
})
export type RuleDryRunAction = z.infer<typeof RuleDryRunAction>

export const RuleDryRunItem = z.object({
  eventId: z.string(),
  eventType: z.string(),
  occurredAt: Timestamp,
  objectId: Uuid.nullable(),
  objectTitle: z.string().nullable(),
  matched: z.boolean(),
  /** Какая ветка выполнилась бы; null — никакая. */
  branch: RuleBranch.nullable(),
  /** Почему не сработало: условие, фильтр, лимит, каузальная цепочка. */
  reason: z.string().nullable(),
  actions: z.array(RuleDryRunAction),
})
export type RuleDryRunItem = z.infer<typeof RuleDryRunItem>

export const RuleDryRunResult = z.object({
  checked: z.number().int(),
  matched: z.number().int(),
  items: z.array(RuleDryRunItem),
})
export type RuleDryRunResult = z.infer<typeof RuleDryRunResult>

// ── Версии, копия, перенос одного правила (ADR-0163) ────────────────────────

export const RULE_VERSION_REASONS = ['create', 'update', 'restore', 'import', 'duplicate'] as const
export const RuleVersionReason = z.enum(RULE_VERSION_REASONS)
export type RuleVersionReason = z.infer<typeof RuleVersionReason>

/** Версия определения правила: каждая правка определения — новая версия. */
export const RuleVersion = z.object({
  id: Uuid,
  number: z.number().int().positive(),
  reason: RuleVersionReason,
  /** Что изменилось относительно предыдущей версии: `trigger`, `actions`… */
  changed: z.array(z.string()),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
  definition: RuleDefinition,
})
export type RuleVersion = z.infer<typeof RuleVersion>

export const RuleVersionList = z.object({ items: z.array(RuleVersion) })
export type RuleVersionList = z.infer<typeof RuleVersionList>

/**
 * Файл одного правила: определение без секретов и без привязок к установке — служебный
 * пользователь снят, правило выключено, секрет подписи вебхука и заголовки с ключами пусты.
 */
export const RULE_EXPORT_FORMAT = 'kchs.rule' as const
export const RuleExport = z.object({
  format: z.literal(RULE_EXPORT_FORMAT),
  version: z.literal(1),
  /** Ключ правила: из названия, бывает и кириллицей (`slugify` правил). */
  key: z.string().trim().min(1).max(120),
  exportedAt: Timestamp,
  definition: RuleDefinition,
})
export type RuleExport = z.infer<typeof RuleExport>

export const RuleImportInput = z.object({ spaceId: Uuid, rule: RuleExport })
export type RuleImportInput = z.infer<typeof RuleImportInput>

/** Ручной запуск правила у объекта (триггер `manual`). */
export const RuleRunNowInput = z.object({ objectId: Uuid.nullable().default(null) })
export type RuleRunNowInput = z.infer<typeof RuleRunNowInput>

export const RuleRunStarted = z.object({ runId: Uuid })
export type RuleRunStarted = z.infer<typeof RuleRunStarted>

/** Правила с кнопкой у объекта: меню «⋯» карточки. */
export const ManualRulesQuery = z.object({ objectId: Uuid })
export type ManualRulesQuery = z.infer<typeof ManualRulesQuery>

export const ManualRule = z.object({
  id: Uuid,
  name: LangText,
  description: z.string().nullable(),
  confirm: z.boolean(),
})
export type ManualRule = z.infer<typeof ManualRule>

export const ManualRuleList = z.object({ items: z.array(ManualRule) })
export type ManualRuleList = z.infer<typeof ManualRuleList>

// ── Справочник конструктора ─────────────────────────────────────────────────

export const RuleEventHint = z.object({
  type: z.string(),
  domain: z.string(),
  /** Поля полезной нагрузки: подсказки `event.payload.<поле>`. */
  payloadFields: z.array(z.string()),
})
export type RuleEventHint = z.infer<typeof RuleEventHint>

export const RuleObjectTypeHint = z.object({
  type: ObjectType,
  /** Поля карточки: подсказки `object.fields.<ключ>`. */
  fields: z.array(z.object({ path: z.string(), label: LangText, type: z.string().nullable() })),
})
export type RuleObjectTypeHint = z.infer<typeof RuleObjectTypeHint>

export const RuleCatalog = z.object({
  events: z.array(RuleEventHint),
  objectTypes: z.array(RuleObjectTypeHint),
  actions: z.array(RuleActionType),
  /** Корни ссылок в выражениях: `event`, `object`, `actor`, `previous`, `now`. */
  roots: z.array(z.string()),
  /** Ключи маршрутов для действия `start_process`. */
  processes: z.array(z.object({ key: z.string(), objectType: z.string(), name: LangText })),
})
export type RuleCatalog = z.infer<typeof RuleCatalog>

/** Шаблон правила из галереи: готовое определение с подстановками. */
export const RuleTemplate = z.object({
  key: Slug,
  name: LangText,
  description: LangText,
  category: z.enum(['documents', 'tasks', 'data', 'meetings', 'general']),
  definition: RuleDefinition,
})
export type RuleTemplate = z.infer<typeof RuleTemplate>

export const RuleTemplateList = z.object({ items: z.array(RuleTemplate) })
export type RuleTemplateList = z.infer<typeof RuleTemplateList>

/** Проверка определения в конструкторе: ошибки и предупреждения. */
export const RuleIssue = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
})
export type RuleIssue = z.infer<typeof RuleIssue>

export const RuleValidateInput = z.object({ definition: RuleDefinition })
export type RuleValidateInput = z.infer<typeof RuleValidateInput>

export const RuleValidateResult = z.object({ ok: z.boolean(), issues: z.array(RuleIssue) })
export type RuleValidateResult = z.infer<typeof RuleValidateResult>
