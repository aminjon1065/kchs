import { useEffect, useState } from 'react'

/**
 * Высота строки таблиц из токена плотности `--row-h` (02-design-system.md,
 * «Размеры контролов и плотность»); пересчитывается при смене плотности.
 */
export function useRowHeight(ref: { current: HTMLElement | null }): number {
  const [height, setHeight] = useState(36)
  useEffect(() => {
    const read = () => {
      const element = ref.current ?? document.documentElement
      const value = Number.parseFloat(getComputedStyle(element).getPropertyValue('--row-h'))
      if (Number.isFinite(value) && value > 0) setHeight(value)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-density'],
    })
    return () => observer.disconnect()
  }, [ref])
  return height
}
