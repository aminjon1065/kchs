import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark' | 'system'
export type Density = 'comfortable' | 'compact'
export type FontSize = 's' | 'm' | 'l'

export interface AppearanceState {
  theme: ThemeMode
  density: Density
  fontSize: FontSize
  locale: 'ru' | 'tg' | 'en'
  setTheme: (theme: ThemeMode) => void
  setDensity: (density: Density) => void
  setFontSize: (size: FontSize) => void
  setLocale: (locale: 'ru' | 'tg' | 'en') => void
}

function apply(state: Pick<AppearanceState, 'theme' | 'density' | 'fontSize' | 'locale'>): void {
  const root = document.documentElement
  if (state.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = state.theme
  root.dataset.density = state.density
  root.dataset.fontSize = state.fontSize
  root.lang = state.locale
}

export const useAppearance = create<AppearanceState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      density: 'comfortable',
      fontSize: 'm',
      locale: 'ru',
      setTheme: (theme) => {
        set({ theme })
        apply({ ...get(), theme })
      },
      setDensity: (density) => {
        set({ density })
        apply({ ...get(), density })
      },
      setFontSize: (fontSize) => {
        set({ fontSize })
        apply({ ...get(), fontSize })
      },
      setLocale: (locale) => {
        set({ locale })
        apply({ ...get(), locale })
      },
    }),
    {
      name: 'kchs.appearance',
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        if (state) apply(state)
      },
    },
  ),
)

export function initAppearance(): void {
  apply(useAppearance.getState())
}
