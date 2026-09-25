import { z } from 'zod'
import { Timestamp } from '../common/primitives.js'

/**
 * Грифы конфиденциальности (08-documents.md §13, ADR-0080) — атрибутное
 * ограничение ядра (03-access-model.md, источник прав №7): объект с грифом
 * выше допуска пользователя недоступен независимо от ACL, роли в пространстве
 * и политики типа. Порядок значений — по строгости. Грифа «Секретно» нет:
 * гостайна обрабатывается только в аттестованных системах (ADR-0142).
 */
export const CONFIDENTIALITY_LEVELS = ['public', 'internal', 'confidential'] as const
export const Confidentiality = z.enum(CONFIDENTIALITY_LEVELS)
export type Confidentiality = z.infer<typeof Confidentiality>

/** Допуск сотрудника без явного атрибута: служебные документы, но не конфиденциальные. */
export const DEFAULT_CLEARANCE: Confidentiality = 'internal'

/** Гостевые ссылки открывают только общедоступное. */
export const GUEST_CLEARANCE: Confidentiality = 'public'

/**
 * Начиная с этого грифа уведомления, Входящие и внешние каналы не показывают
 * содержания — только «Документ № …» (08-documents.md §13).
 */
export const REDACT_FROM: Confidentiality = 'confidential'

export function confidentialityRank(value: Confidentiality): number {
  return CONFIDENTIALITY_LEVELS.indexOf(value)
}

/**
 * Снятые значения: старая копия базы или пакет конфигурации ещё может принести
 * «Секретно» — это самый строгий из оставшихся грифов, а не ДСП (ADR-0142).
 */
const LEGACY_LEVELS: Readonly<Record<string, Confidentiality>> = { secret: 'confidential' }

/** Значение из хранилища (jsonb, текст) — к грифу; неизвестное — `fallback`. */
export function parseConfidentiality(
  value: unknown,
  fallback: Confidentiality = DEFAULT_CLEARANCE,
): Confidentiality {
  if (typeof value !== 'string') return fallback
  if ((CONFIDENTIALITY_LEVELS as readonly string[]).includes(value)) return value as Confidentiality
  return LEGACY_LEVELS[value] ?? fallback
}

/** Грифы, которые открыты допуску: все не строже его. */
export function allowedConfidentiality(clearance: Confidentiality): Confidentiality[] {
  return CONFIDENTIALITY_LEVELS.slice(0, confidentialityRank(clearance) + 1)
}

/** Допуски, которым открыт гриф: все не ниже его. */
export function clearancesFor(level: Confidentiality): Confidentiality[] {
  return CONFIDENTIALITY_LEVELS.slice(confidentialityRank(level))
}

export function withinClearance(level: Confidentiality, clearance: Confidentiality): boolean {
  return confidentialityRank(level) <= confidentialityRank(clearance)
}

/** Самый строгий из грифов (объект и объекты, к которым он прикреплён). */
export function strictest(...levels: Confidentiality[]): Confidentiality {
  return levels.reduce<Confidentiality>(
    (acc, level) => (confidentialityRank(level) > confidentialityRank(acc) ? level : acc),
    'public',
  )
}

export function isRedacted(level: Confidentiality | null | undefined): boolean {
  return level ? confidentialityRank(level) >= confidentialityRank(REDACT_FROM) : false
}

/** Допуск сотрудника задаёт администратор системы с обоснованием (аудит). */
export const ClearanceInput = z.object({
  clearance: Confidentiality,
  reason: z.string().trim().min(3).max(500),
})
export type ClearanceInput = z.infer<typeof ClearanceInput>

/**
 * Режим администратора (03-access-model.md §1, ADR-0080): администратор
 * системы видит объекты с грифом выше своего допуска только после явного
 * входа с обоснованием; режим живёт в сессии и ограничен по времени.
 */
export const ADMIN_MODE_MINUTES = { default: 30, min: 5, max: 120 } as const

export const AdminModeInput = z.object({
  reason: z.string().trim().min(10).max(500),
  minutes: z
    .number()
    .int()
    .min(ADMIN_MODE_MINUTES.min)
    .max(ADMIN_MODE_MINUTES.max)
    .default(ADMIN_MODE_MINUTES.default),
})
export type AdminModeInput = z.infer<typeof AdminModeInput>

export const AdminModeState = z.object({
  reason: z.string(),
  until: Timestamp,
})
export type AdminModeState = z.infer<typeof AdminModeState>
