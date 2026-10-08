import type { Basemap, BasemapTheme, ReliefLevel } from '@kchs/contracts'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Личный выбор подложки (ADR-0196): каждый сотрудник сам выбирает подложку и силу рельефа
 * на любой карте. Выбор запоминается в браузере (как оформление интерфейса) и действует на
 * всех картах; «Как в карте» — подложка, которую задал автор карты (или по умолчанию
 * установки). Печать и отчёты личный выбор не учитывают — они рисуют карту как задано.
 */

/**
 * Вариант подложки: у векторной — `scheme` (светлая или тёмная по теме интерфейса) и `muted`
 * (серая, под данные); у растровой — `plain` и `hybrid` (снимок с подписями и дорогами).
 */
export type BasemapVariant = 'scheme' | 'muted' | 'plain' | 'hybrid'

export interface BasemapChoice {
  basemapId: string
  variant: BasemapVariant
}

interface BasemapChoiceState {
  /** null — как в карте. */
  choice: BasemapChoice | null
  relief: ReliefLevel
  choose: (choice: BasemapChoice | null) => void
  setRelief: (relief: ReliefLevel) => void
}

export const useBasemapChoice = create<BasemapChoiceState>()(
  persist(
    (set) => ({
      choice: null,
      relief: 'normal',
      choose: (choice) => set({ choice }),
      setRelief: (relief) => set({ relief }),
    }),
    {
      name: 'kchs.basemap',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ choice, relief }) => ({ choice, relief }),
    },
  ),
)

/** Подложка по умолчанию для карты: заданная автором, иначе по умолчанию установки, иначе первая. */
export function autoBasemap(
  items: readonly Basemap[],
  mapBasemapId: string | null,
): Basemap | null {
  return (
    items.find((item) => item.id === mapBasemapId) ??
    items.find((item) => item.isDefault) ??
    items[0] ??
    null
  )
}

export interface ResolvedBasemap {
  basemap: Basemap | null
  theme: BasemapTheme
  /** «Гибрид»: подписи, дороги и границы поверх снимка. */
  labels: boolean
}

/**
 * Что рисует карта: личный выбор, если подложка ещё есть в реестре и вариант ей подходит,
 * иначе — как в карте. `autoTheme` — тема вида по умолчанию (`muted` у паспорта территории и
 * точки на форме), `mode` — светлая или тёмная тема интерфейса для варианта «Схема».
 */
export function resolveBasemap(
  items: readonly Basemap[],
  choice: BasemapChoice | null,
  mapBasemapId: string | null,
  autoTheme: BasemapTheme,
  mode: 'light' | 'dark',
): ResolvedBasemap {
  const picked = choice ? items.find((item) => item.id === choice.basemapId) : undefined
  if (picked && choice && variantsOf(picked, items).includes(choice.variant)) {
    return {
      basemap: picked,
      theme: choice.variant === 'muted' ? 'muted' : mode,
      labels: choice.variant === 'hybrid',
    }
  }
  return { basemap: autoBasemap(items, mapBasemapId), theme: autoTheme, labels: false }
}

/**
 * Варианты подложки в переключателе: у векторной — схема и серая, у снимков — и «Гибрид»,
 * если в установке есть векторная подложка (подписи и дороги берутся из неё).
 */
export function variantsOf(basemap: Basemap, items: readonly Basemap[]): BasemapVariant[] {
  if (basemap.kind === 'vector') return ['scheme', 'muted']
  if (basemap.kind === 'none') return ['plain']
  const overlay = items.some((item) => item.kind === 'vector')
  return basemap.imagery && overlay ? ['plain', 'hybrid'] : ['plain']
}
