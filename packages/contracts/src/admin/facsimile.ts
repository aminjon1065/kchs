import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp } from '../common/primitives.js'

/**
 * Факсимиле сотрудника (ADR-0198): заранее загруженное изображение подписи, которое
 * рендер подписанного экземпляра ставит у фамилии. Реквизит справочника людей, а не
 * файл реестра: картинку видит только сам сотрудник, администратор её заменяет или
 * удаляет, но не видит.
 */

/** Предел PNG: картинка подписи, а не скан страницы. */
export const FACSIMILE_MAX_BYTES = 256 * 1024
/** Предел размеров PNG в пикселях. */
export const FACSIMILE_MAX_WIDTH = 1200
export const FACSIMILE_MAX_HEIGHT = 600

/** Загрузка: PNG в base64 (без префикса `data:`). */
export const FacsimileInput = z.object({
  png: z
    .string()
    .min(16)
    .max(Math.ceil((FACSIMILE_MAX_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
})
export type FacsimileInput = z.infer<typeof FacsimileInput>

/** Есть ли факсимиле и какое: без самой картинки (её видит только владелец). */
export const FacsimileState = z.object({
  present: z.boolean(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  updatedAt: Timestamp.nullable(),
  updatedBy: UserRef.nullable(),
})
export type FacsimileState = z.infer<typeof FacsimileState>

/** Своё факсимиле: то же и картинка для предпросмотра в профиле. */
export const OwnFacsimile = FacsimileState.extend({
  /** `data:image/png;base64,…` — только владельцу. */
  dataUri: z.string().nullable(),
})
export type OwnFacsimile = z.infer<typeof OwnFacsimile>
