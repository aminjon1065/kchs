import { z } from 'zod'
import { DateOnly, LangText } from '../common/primitives.js'

/**
 * Производственный календарь (01-vision.md A3, ADR-0044): исключения из
 * правила «понедельник–пятница — рабочие дни». `holiday` — праздник, `weekend`
 * — перенесённый выходной, `work` — рабочая суббота или воскресенье, `short` —
 * сокращённый рабочий день (рабочий).
 */
export const BUSINESS_DAY_KINDS = ['holiday', 'weekend', 'work', 'short'] as const
export const BusinessDayKind = z.enum(BUSINESS_DAY_KINDS)
export type BusinessDayKind = z.infer<typeof BusinessDayKind>

export const BusinessDay = z.object({
  day: DateOnly,
  kind: BusinessDayKind,
  note: LangText.nullable(),
})
export type BusinessDay = z.infer<typeof BusinessDay>

/** Исключения года; дни, которых нет в списке, — по правилу недели. */
export const BusinessCalendarYear = z.object({
  country: z.string(),
  year: z.number().int(),
  days: z.array(BusinessDay),
})
export type BusinessCalendarYear = z.infer<typeof BusinessCalendarYear>

export const BusinessDayInput = z.object({
  kind: BusinessDayKind,
  note: LangText.nullable().default(null),
})
export type BusinessDayInput = z.infer<typeof BusinessDayInput>
