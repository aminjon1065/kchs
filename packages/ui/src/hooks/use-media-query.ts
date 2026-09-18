import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )

  useEffect(() => {
    const media = window.matchMedia(query)
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [query])

  return matches
}

/** Границы адаптивности из 03-ui/01-ux-concept.md §9. */
export type Breakpoint = 'mobile' | 'tablet' | 'laptop' | 'desktop'

export function useBreakpoint(): Breakpoint {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1279px)')
  const isLaptop = useMediaQuery('(min-width: 1280px) and (max-width: 1439px)')
  if (isMobile) return 'mobile'
  if (isTablet) return 'tablet'
  if (isLaptop) return 'laptop'
  return 'desktop'
}
