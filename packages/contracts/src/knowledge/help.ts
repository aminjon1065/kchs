import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Справка (вопрос N88): пункт «Справка» открывает страницу базы знаний — свою для
 * каждого языка интерфейса. Без страницы на языке сотрудника открывается русская;
 * без обеих пункта нет. Сид заводит краткое руководство и выбирает его корни.
 */
export const HelpPages = z.object({
  ru: Uuid.nullable(),
  tg: Uuid.nullable(),
  en: Uuid.nullable(),
})
export type HelpPages = z.infer<typeof HelpPages>

export const HelpPagesPatch = HelpPages.partial()
export type HelpPagesPatch = z.infer<typeof HelpPagesPatch>

/** Что открывает «Справка» у спрашивающего; `null` — пункта нет. */
export const HelpLink = z.object({
  page: z.object({ id: Uuid, title: z.string() }).nullable(),
})
export type HelpLink = z.infer<typeof HelpLink>
