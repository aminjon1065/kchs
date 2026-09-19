import {
  DEFAULT_LOCALE,
  dictionaries,
  FALLBACK_LOCALE,
  INTL_LOCALE,
  type Locale,
} from './resources.js'
import type { TranslateParams } from './types.js'

function lookup(dict: unknown, path: string[]): string | undefined {
  let node: unknown = dict
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return typeof node === 'string' ? node : undefined
}

/** Индекс парной закрывающей скобки для `{` в позиции `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Ветви плюрализации: `one {…} few {…} =0 {…}` — с учётом вложенных скобок. */
function parseBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>()
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] as string)) i += 1
    const keyStart = i
    while (i < body.length && body[i] !== '{' && !/\s/.test(body[i] as string)) i += 1
    const key = body.slice(keyStart, i)
    while (i < body.length && /\s/.test(body[i] as string)) i += 1
    if (key.length === 0 || body[i] !== '{') break
    const close = matchBrace(body, i)
    if (close === -1) break
    branches.set(key, body.slice(i + 1, close))
    i = close + 1
  }
  return branches
}

function renderPlural(key: string, body: string, params: TranslateParams, locale: Locale): string {
  const value = Number(params[key] ?? 0)
  const category = new Intl.PluralRules(INTL_LOCALE[locale]).select(value)
  const branches = parseBranches(body)
  const chosen = branches.get(`=${value}`) ?? branches.get(category) ?? branches.get('other') ?? ''
  const formatted = new Intl.NumberFormat(INTL_LOCALE[locale]).format(value)
  return interpolate(chosen.replace(/#/g, formatted), params, locale)
}

/** Выбор по значению: `{status, select, done {Готово} other {{status}}}`. */
function renderSelect(key: string, body: string, params: TranslateParams, locale: Locale): string {
  const branches = parseBranches(body)
  const value = params[key]
  const chosen =
    (value === undefined ? undefined : branches.get(String(value))) ?? branches.get('other') ?? ''
  return interpolate(chosen, params, locale)
}

/**
 * Подстановка `{name}`, ICU-плюрализация `{count, plural, one {…} other {…}}` и
 * выбор `{key, select, a {…} other {…}}` с учётом вложенных фигурных скобок.
 * Достаточно для серверных текстов (уведомления, письма, Telegram) и для
 * клиента — словарь один и тот же.
 */
function interpolate(template: string, params: TranslateParams, locale: Locale): string {
  let out = ''
  let i = 0

  while (i < template.length) {
    const open = template.indexOf('{', i)
    if (open === -1) {
      out += template.slice(i)
      break
    }
    out += template.slice(i, open)

    const close = matchBrace(template, open)
    if (close === -1) {
      out += template.slice(open)
      break
    }

    const inner = template.slice(open + 1, close)
    const plural = /^(\w+),\s*plural,\s*([\s\S]*)$/.exec(inner)
    const select = plural ? null : /^(\w+),\s*select,\s*([\s\S]*)$/.exec(inner)
    if (plural) {
      out += renderPlural(plural[1] as string, plural[2] as string, params, locale)
    } else if (select) {
      out += renderSelect(select[1] as string, select[2] as string, params, locale)
    } else if (/^\w+$/.test(inner)) {
      const value = params[inner]
      if (value === undefined) out += template.slice(open, close + 1)
      else if (value instanceof Date) out += value.toISOString()
      else out += String(value)
    } else {
      out += template.slice(open, close + 1)
    }
    i = close + 1
  }

  return out
}

export interface Translator {
  (key: string, params?: TranslateParams): string
  locale: Locale
}

export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  const t = ((key: string, params: TranslateParams = {}) => {
    const path = key.split('.')
    const template =
      lookup(dictionaries[locale], path) ?? lookup(dictionaries[FALLBACK_LOCALE], path)
    if (!template) return key
    return interpolate(template, params, locale)
  }) as Translator
  t.locale = locale
  return t
}

/** Разовый перевод без создания переводчика. */
export function translate(locale: Locale, key: string, params: TranslateParams = {}): string {
  return createTranslator(locale)(key, params)
}

/** Есть ли ключ хотя бы в одном словаре — используется скриптом проверки. */
export function hasKey(key: string, locale: Locale = FALLBACK_LOCALE): boolean {
  return lookup(dictionaries[locale], key.split('.')) !== undefined
}

/** Текст данных на нескольких языках (названия подразделений, ролей, справочников). */
export interface LocalizedText {
  ru: string
  tg?: string
  en?: string
}

/** Текст на языке интерфейса; нет перевода — основной язык `ru`. */
export function localizedText(text: LocalizedText, locale: Locale): string {
  return text[locale]?.trim() || text.ru
}
