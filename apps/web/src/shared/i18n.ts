import {
  createTranslator,
  dictionariesVersion,
  isNamespaceLoaded,
  type Locale,
  loadNamespaces,
  type Namespace,
  subscribeDictionaries,
  type Translator,
} from '@kchs/i18n'
import {
  createElement,
  Fragment,
  type ReactNode,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { useAppearance, useLocale } from '~/shared/appearance.js'

/**
 * Перевод интерфейса. Словари — общие с сервером (`@kchs/i18n`),
 * подстановка и ICU-плюрализация — тот же алгоритм, что в уведомлениях.
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useLocale()
  const version = useSyncExternalStore(subscribeDictionaries, dictionariesVersion)
  return translatorFor(locale, version)
}

export function t(key: string, params?: Record<string, string | number>): string {
  return createTranslator(useAppearance.getState().locale as Locale)(key, params)
}

// Один переводчик на язык и версию словарей: стабильная ссылка не сбрасывает мемоизацию
// компонентов, а неймспейс, догруженный по ключу (ADR-0191), даёт новую — тексты пересчитываются
let current: { locale: Locale; version: number; translate: Translator } | undefined

function translatorFor(locale: Locale, version: number): Translator {
  if (current?.locale !== locale || current.version !== version) {
    current = { locale, version, translate: createTranslator(locale) }
  }
  return current.translate
}

// ─── Неймспейсы модулей (ADR-0191) ───────────────────────────────────────────

const pending = new Map<string, Promise<void>>()

/**
 * Загрузка неймспейсов на языке — одно обещание на набор, пока она идёт (`use()` ждёт его
 * без повторных запросов); `null`, если всё уже загружено.
 */
function namespacesPending(locale: Locale, namespaces: readonly Namespace[]): Promise<void> | null {
  if (namespaces.every((namespace) => isNamespaceLoaded(locale, namespace))) return null
  const id = `${locale}:${namespaces.join(',')}`
  let promise = pending.get(id)
  if (!promise) {
    promise = loadNamespaces(locale, namespaces).finally(() => pending.delete(id))
    // Ошибку чанка показывает граница ошибок того, кто ждёт; повтор — новой загрузкой
    promise.catch(() => undefined)
    pending.set(id, promise)
  }
  return promise
}

/** Компонент ждёт неймспейсы текущего языка: заглушку рисует ближайший Suspense. */
export function useNamespaces(namespaces: readonly Namespace[]): void {
  const promise = namespacesPending(useLocale(), namespaces)
  if (promise) use(promise)
}

/**
 * Без Suspense: `false`, пока неймспейсы текущего языка грузятся (загрузка уже запущена),
 * после загрузки компонент перерисовывается. Для хуков, которые оболочка зовёт всегда, —
 * команды палитры модуля.
 */
export function useNamespacesReady(namespaces: readonly Namespace[]): boolean {
  const promise = namespacesPending(useLocale(), namespaces)
  const [, setLoaded] = useState(0)
  useEffect(() => {
    if (!promise) return
    let active = true
    promise.then(
      () => {
        if (active) setLoaded((count) => count + 1)
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [promise])
  return promise === null
}

function NamespacesReady({ namespaces }: { namespaces: readonly Namespace[] }): null {
  useNamespaces(namespaces)
  return null
}

/**
 * Узел показывается, когда неймспейсы текущего языка загружены; до того — заглушка
 * ближайшего Suspense, а не сырые ключи. Загрузка запускается сразу и идёт параллельно с
 * чанком ленивого экрана. Так реестр показывает экраны модулей, а оболочка — экраны вне
 * рабочего пространства.
 */
export function withNamespaces(namespaces: readonly Namespace[], node: ReactNode): ReactNode {
  if (namespaces.length === 0) return node
  namespacesPending(useAppearance.getState().locale, namespaces)
  return createElement(Fragment, null, createElement(NamespacesReady, { namespaces }), node)
}
