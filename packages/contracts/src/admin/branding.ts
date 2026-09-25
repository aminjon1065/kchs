import { z } from 'zod'

/** Акценты дизайн-системы (03-ui/02-design-system.md): контраст каждого проверен. */
export const BRAND_ACCENTS = ['blue', 'green', 'violet', 'teal', 'maroon'] as const
export const BrandAccent = z.enum(BRAND_ACCENTS)
export type BrandAccent = z.infer<typeof BrandAccent>

/** Логотип хранится в настройке значением `data:`: он нужен и до входа. */
export const BRAND_LOGO_MAX_BYTES = 256 * 1024
const LOGO_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/

/**
 * Брендирование установки (15-admin-operations.md §1): название, логотип,
 * акцентный цвет и приписка на экране входа. Хранится системными настройками
 * `brand.*`; печатные формы берут отсюда же название и логотип (ADR-0085).
 */
/**
 * Название продукта для пользователей (решение владельца, Q13): приложение для
 * ключей входа, эмитент кодов второго фактора, пуш-уведомления, отправитель
 * писем. Интерфейс берёт его же из словаря (`common.appName`).
 */
export const PRODUCT_NAME = 'Портал КЧС'

export const Branding = z.object({
  /** Полное название организации — шапки печатных форм и заголовок окна. */
  name: z.string().max(120).default(''),
  /** Короткое название — рейка и узкие места оболочки. */
  shortName: z.string().max(40).default(''),
  /** Логотип: `data:` с png, jpeg, webp или svg, не больше 256 КБ. */
  logo: z.string().max(BRAND_LOGO_MAX_BYTES).regex(LOGO_RE).nullable().default(null),
  accent: BrandAccent.default('blue'),
  /** Приписка на экране входа: «Система для служебного пользования» и подобное. */
  loginNote: z.string().max(400).default(''),
})
export type Branding = z.infer<typeof Branding>

export const BrandingPatch = z
  .object({
    name: Branding.shape.name.unwrap(),
    shortName: Branding.shape.shortName.unwrap(),
    logo: Branding.shape.logo.unwrap(),
    accent: Branding.shape.accent.unwrap(),
    loginNote: Branding.shape.loginNote.unwrap(),
  })
  .partial()
export type BrandingPatch = z.infer<typeof BrandingPatch>
