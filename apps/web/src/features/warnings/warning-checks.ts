import { WARNING_LANGUAGES, type WarningInfos, type WarningLanguage } from '@kchs/contracts'

/** CAP советует заголовок до 160 знаков: его показывают SMS и телефоны. */
export const HEADLINE_LIMIT = 160

/** Языки, без которых предупреждение не уйдёт на решение (как `readinessIssues` сервера). */
export const REQUIRED_LANGUAGES: readonly WarningLanguage[] = ['tg', 'ru']

/** Блок языка заполнен: есть заголовок и описание — то, что требует сервер. */
export function languageFilled(infos: WarningInfos, language: WarningLanguage): boolean {
  const info = infos[language]
  return Boolean(info?.headline.trim() && info.description.trim())
}

export type CheckState = 'ok' | 'missing'

export interface WarningCheck {
  key: 'languages' | 'areas' | 'headline' | 'expires' | 'categories' | 'signer'
  state: CheckState
}

export interface WarningChecksInput {
  info: WarningInfos
  categories: readonly string[]
  areas: readonly unknown[]
  expires: string | null
  signerId: string | null
}

export interface WarningChecksResult {
  checks: WarningCheck[]
  /** Незаполненные языки: обязательные и английский. */
  missingLanguages: WarningLanguage[]
  /** Языки, где заголовок длиннее лимита (из старых данных или ленты). */
  longHeadlines: WarningLanguage[]
  /** Срок действия задан, но уже прошёл. */
  expired: boolean
}

/**
 * Проверка перед отправкой и подписью (ADR-0230): то же, что сервер требует при
 * отправке на решение, — языки, области, срок, категория, подписывающий, — плюс длина
 * заголовков для SMS. Категория и подписывающий показываются, только когда не заданы.
 */
export function warningChecks(
  input: WarningChecksInput,
  now: number = Date.now(),
): WarningChecksResult {
  const missingLanguages = WARNING_LANGUAGES.filter(
    (language) => !languageFilled(input.info, language),
  )
  const longHeadlines = WARNING_LANGUAGES.filter(
    (language) => (input.info[language]?.headline.length ?? 0) > HEADLINE_LIMIT,
  )
  const requiredMissing = missingLanguages.some((language) => REQUIRED_LANGUAGES.includes(language))
  const expired = input.expires !== null && new Date(input.expires).getTime() <= now
  const checks: WarningCheck[] = [
    { key: 'languages', state: requiredMissing ? 'missing' : 'ok' },
    { key: 'areas', state: input.areas.length > 0 ? 'ok' : 'missing' },
    { key: 'headline', state: longHeadlines.length > 0 ? 'missing' : 'ok' },
    { key: 'expires', state: input.expires !== null && !expired ? 'ok' : 'missing' },
  ]
  if (input.categories.length === 0) checks.push({ key: 'categories', state: 'missing' })
  if (!input.signerId) checks.push({ key: 'signer', state: 'missing' })
  return { checks, missingLanguages, longHeadlines, expired }
}

/** Население областей: сумма, если известно у каждой территории, иначе `null`. */
export function totalPopulation(values: ReadonlyArray<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

/** Население из атрибутов справочника: число или строка с числом, иначе `null`. */
export function populationOf(attributes: Record<string, unknown> | undefined): number | null {
  const raw = attributes?.population
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** Источник численности (`attributes.population_source.source`), если записан. */
export function populationSourceOf(attributes: Record<string, unknown> | undefined): string | null {
  const source = attributes?.population_source
  if (source && typeof source === 'object' && 'source' in source) {
    const text = (source as { source: unknown }).source
    return typeof text === 'string' && text.trim() ? text.trim() : null
  }
  return null
}

/**
 * Время до срока решения: минуты, отрицательные — просрочено. Без срока — `null`.
 */
export function minutesLeft(dueAt: string | null, now: number = Date.now()): number | null {
  if (!dueAt) return null
  return Math.round((new Date(dueAt).getTime() - now) / 60_000)
}
