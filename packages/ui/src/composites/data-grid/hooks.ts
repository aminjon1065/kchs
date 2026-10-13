import { useCallback, useRef } from 'react'

/**
 * Служебные хуки таблицы данных: последнее значение в ссылке, стабильный обработчик
 * и слоты строк окна виртуализации.
 */

export function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/**
 * Слоты строк окна: строка, оставшаяся в окне, сохраняет слот (и не
 * перерисовывается), пришедшая занимает слот ушедшей — React переиспользует
 * её DOM-узлы вместо создания новых. Повторный вызов с тем же окном даёт
 * те же слоты, поэтому двойная отрисовка StrictMode безопасна.
 */
export function useRowSlots(items: ReadonlyArray<{ index: number }>): ReadonlyMap<number, number> {
  const ref = useRef<ReadonlyMap<number, number>>(new Map())
  const previous = ref.current
  const next = new Map<number, number>()
  const taken = new Set<number>()
  let top = -1
  for (const slot of previous.values()) top = Math.max(top, slot)
  for (const { index } of items) {
    const slot = previous.get(index)
    if (slot === undefined) continue
    next.set(index, slot)
    taken.add(slot)
  }
  const free = [...previous.values()].filter((slot) => !taken.has(slot))
  for (const { index } of items) {
    if (!next.has(index)) next.set(index, free.pop() ?? ++top)
  }
  ref.current = next
  return next
}

/** Стабильная ссылка на обработчик со свежим замыканием — для мемоизированных детей. */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}
