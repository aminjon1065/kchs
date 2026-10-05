import { CORE_LOADERS, MODULE_LOADERS } from './loaders.js'
import { core } from './locales/ru/core.js'
import { isCoreNamespace, isNamespace, type ModuleNamespace, type Namespace } from './namespaces.js'
import {
  isLocaleLoaded,
  isNamespaceLoaded,
  notifyDictionaries,
  onMissingNamespace,
  registerNamespaces,
} from './registry.js'
import type { Locale } from './resources.js'

/**
 * Вход браузера (условие `browser`, ADR-0166, ADR-0191). В основном чанке — неймспейсы
 * оболочки `ru`; неймспейсы оболочки `tg` и `en` грузит `loadLocale()` одним чанком на язык,
 * модульные неймспейсы — `loadNamespaces()` отдельными чанками, когда модуль их объявил.
 */
registerNamespaces('ru', core)

/** Модульные неймспейсы, которые уже запрашивались: при смене языка они грузятся и на новом. */
const requested = new Set<ModuleNamespace>()
const inflight = new Map<string, Promise<void>>()

function once(id: string, load: () => Promise<void>): Promise<void> {
  const current = inflight.get(id)
  if (current) return current
  const promise = load().finally(() => inflight.delete(id))
  inflight.set(id, promise)
  return promise
}

function loadCore(locale: Locale): Promise<void> {
  if (locale === 'ru' || isLocaleLoaded(locale)) return Promise.resolve()
  return once(`${locale}:core`, async () => {
    registerNamespaces(locale, await CORE_LOADERS[locale]())
  })
}

function loadModule(locale: Locale, namespace: ModuleNamespace): Promise<void> {
  if (isNamespaceLoaded(locale, namespace)) return Promise.resolve()
  return once(`${locale}:${namespace}`, async () => {
    registerNamespaces(locale, { [namespace]: await MODULE_LOADERS[locale][namespace]() })
  })
}

const isModuleNamespace = (namespace: Namespace): namespace is ModuleNamespace =>
  !isCoreNamespace(namespace)

/**
 * Неймспейсы на языке: модуль объявляет их в `registerModule`, и экран ждёт загрузки
 * (ADR-0191). Неймспейсы оболочки языка грузятся заодно.
 */
export function loadNamespaces(locale: Locale, namespaces: readonly Namespace[]): Promise<void> {
  const modules = namespaces.filter(isModuleNamespace)
  for (const namespace of modules) requested.add(namespace)
  return Promise.all([
    loadCore(locale),
    ...modules.map((namespace) => loadModule(locale, namespace)),
  ]).then(() => undefined)
}

/** Язык интерфейса: неймспейсы оболочки и все модульные, что уже запрашивались. */
export function loadLocale(locale: Locale): Promise<void> {
  return Promise.all([
    loadCore(locale),
    ...[...requested].map((namespace) => loadModule(locale, namespace)),
  ]).then(() => undefined)
}

// Ключ модульного неймспейса, которого никто не объявил: неймспейс догружается, и подписчики
// перерисовываются. Объявленный и ещё не загруженный — просто пустая строка: экран его ждёт.
onMissingNamespace((locale, namespace) => {
  if (!isNamespace(namespace) || !isModuleNamespace(namespace)) return false
  if (!requested.has(namespace)) {
    console.warn(`[i18n] неймспейс «${namespace}» не объявлен модулем — загружается по ключу`)
    loadNamespaces(locale, [namespace]).then(notifyDictionaries, () => undefined)
  }
  return true
})

export * from './namespaces.js'
export {
  dictionariesVersion,
  isLocaleLoaded,
  isNamespaceLoaded,
  subscribeDictionaries,
} from './registry.js'
export * from './resources.js'
export * from './translate.js'
export type { DeepPartial, TranslateParams } from './types.js'
