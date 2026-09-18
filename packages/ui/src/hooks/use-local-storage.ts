import { useCallback, useEffect, useState } from 'react'

/** Локальное состояние, переживающее перезагрузку (ширины панелей, плотность). */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = window.localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // приватный режим — игнорируем
    }
  }, [key, value])

  const set = useCallback((next: T) => setValue(next), [])
  return [value, set]
}
