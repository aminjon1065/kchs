import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Сравнение версий документа (08-documents.md §8, ADR-0085): текстовое — по
 * извлечённому тексту основных файлов (сравнение по словам), визуальное —
 * PDF-представления рядом (интерфейс берёт их из списка версий).
 */
export const VersionCompareQuery = z.object({ from: Uuid, to: Uuid })
export type VersionCompareQuery = z.infer<typeof VersionCompareQuery>

export const DIFF_OPS = ['equal', 'insert', 'delete'] as const
export const DiffOp = z.enum(DIFF_OPS)
export type DiffOp = z.infer<typeof DiffOp>

export const DiffSegment = z.object({ op: DiffOp, text: z.string() })
export type DiffSegment = z.infer<typeof DiffSegment>

/**
 * `ready` — сравнено; `pending` — движок ещё извлекает текст; `unavailable` —
 * у версии нет текста (неподдерживаемый формат, сбой извлечения).
 */
export const VERSION_COMPARE_STATUSES = ['ready', 'pending', 'unavailable'] as const

export const VersionCompareResult = z.object({
  from: z.object({ id: Uuid, number: z.number().int() }),
  to: z.object({ id: Uuid, number: z.number().int() }),
  status: z.enum(VERSION_COMPARE_STATUSES),
  segments: z.array(DiffSegment),
  /** Число слов: добавлено, удалено, без изменений. */
  stats: z.object({
    inserted: z.number().int(),
    deleted: z.number().int(),
    unchanged: z.number().int(),
  }),
  /** Текст длиннее предела сравнения — сравнено начало. */
  truncated: z.boolean(),
})
export type VersionCompareResult = z.infer<typeof VersionCompareResult>
