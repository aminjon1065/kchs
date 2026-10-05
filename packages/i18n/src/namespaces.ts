import type { Dictionary } from './locales/ru/index.js'

/**
 * Неймспейс словаря — ключ верхнего уровня (`data` в `data.explore.title`) и файл
 * `locales/<язык>/<неймспейс>.ts` (ADR-0191).
 */
export type Namespace = keyof Dictionary

/** Все неймспейсы в порядке словаря `ru`. Сверку с файлами и индексами языков делает `i18n:check`. */
export const NAMESPACES = [
  'common',
  'ui',
  'auth',
  'shell',
  'home',
  'inbox',
  'notifications',
  'telegram',
  'activity',
  'objects',
  'access',
  'documents',
  'spaces',
  'files',
  'gis',
  'data',
  'tasks',
  'processes',
  'processDesigner',
  'documentAssist',
  'calendar',
  'chats',
  'meetings',
  'discussion',
  'assistant',
  'knowledge',
  'search',
  'profile',
  'admin',
  'automation',
  'forms',
  'alerts',
  'schedules',
  'errors',
] as const satisfies readonly Namespace[]

/**
 * Неймспейсы оболочки — то, что нужно до входа и в каркасе: рейка, вкладки, палитра,
 * контекст-панель (объект, доступ, лента, обсуждение, вложения), навигатор пространств,
 * «Мой день» и Входящие. В вебе их `ru` — в основном чанке, `tg` и `en` — одним чанком на
 * язык. Остальные неймспейсы — модульные: грузятся с экраном модуля, который их объявил.
 */
export const CORE_NAMESPACES = [
  'common',
  'ui',
  'errors',
  'auth',
  'shell',
  'objects',
  'access',
  'activity',
  'discussion',
  'spaces',
  'search',
  'inbox',
  'home',
  'files',
] as const satisfies readonly Namespace[]

export type CoreNamespace = (typeof CORE_NAMESPACES)[number]
export type ModuleNamespace = Exclude<Namespace, CoreNamespace>

const known = new Set<string>(NAMESPACES)
const core = new Set<string>(CORE_NAMESPACES)

export function isNamespace(value: string): value is Namespace {
  return known.has(value)
}

export function isCoreNamespace(namespace: string): namespace is CoreNamespace {
  return core.has(namespace)
}
