import { z } from 'zod'

/** Идентификатор объекта реестра и большинства таблиц: UUID v7. */
export const Uuid = z.uuid()
export type Uuid = z.infer<typeof Uuid>

/** Идентификатор события: ULID/UUIDv7 (contracts/events.md). */
export const EventId = z.string().min(16).max(36)

/** Строка датасета и другие высокочастотные записи: bigint в виде строки. */
export const BigIntString = z.string().regex(/^-?\d+$/, 'ожидается целое число')

export const Timestamp = z.iso.datetime({ offset: true })
export type Timestamp = z.infer<typeof Timestamp>

export const DateOnly = z.iso.date()

/** Локали интерфейса: ru — основная (01-vision.md, допущение A3). */
export const LOCALES = ['ru', 'tg', 'en'] as const
export const Locale = z.enum(LOCALES)
export type Locale = z.infer<typeof Locale>

/** Многоязычная подпись справочника: jsonb {"ru","tg","en"}. */
export const LangText = z.object({
  ru: z.string(),
  tg: z.string().optional(),
  en: z.string().optional(),
})
export type LangText = z.infer<typeof LangText>

export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'только строчные латинские буквы, цифры, - и _')

export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const Json: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(Json),
    z.record(z.string(), Json),
  ]),
)
