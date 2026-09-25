import type { FeatureGeometry } from '@kchs/contracts'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { DrawController, DrawTool } from './draw-controller.js'

/**
 * Сеанс правки объектов на карте-студии (ADR-0076): слой в режиме правки,
 * инструмент, объект (новый или существующий), черновик геометрии и значения
 * формы. Тулбар (`studio/edit-tools.tsx`) и правая панель (`studio/edit-panel.tsx`)
 * — разные слоты студии, поэтому состояние — в хранилище карты, а не в компоненте.
 */

/** Правимый объект: новый (`rowId` null) или строка слоя с версией, которую видел пользователь. */
export interface EditTarget {
  rowId: string | null
  ver: number | null
  /** Значения полей при загрузке — для отправки только изменённых. */
  values: Record<string, unknown>
  /** Геометрия при загрузке — «как было» и признак изменения. */
  original: FeatureGeometry | null
  /** Контур с внутренними границами: terra-draw их не правит — только атрибуты. */
  geometryLocked: boolean
}

/** Геометрия поверх карты: «как было» из истории или предложенная правка. */
export interface Ghost {
  geometry: FeatureGeometry
  tone: 'previous' | 'proposed'
}

export interface EditState {
  layerId: string | null
  tool: DrawTool
  snapping: boolean
  target: EditTarget | null
  /** Черновик геометрии: null — ещё не нарисован. */
  geometry: FeatureGeometry | null
  /** Черновик составной геометрии (части сохраняются составной). */
  multi: boolean
  values: Record<string, unknown>
  /** Территория подставлена по карте, а не выбрана вручную. */
  autoTerritory: boolean
  ghost: Ghost | null
  /** Панель: вкладка, которую нужно открыть (после выбора объекта — «Объект»). */
  tab: 'feature' | 'history' | 'edits'
  controller: DrawController | null
  /** Прежние состояния черновика — «Отменить» (ADR-0160); сбрасываются новым объектом. */
  past: Array<FeatureGeometry | null>
  /** Отменённые состояния — «Повторить»; новая правка их забывает. */
  future: Array<FeatureGeometry | null>
}

interface EditActions {
  start: (layerId: string) => void
  stop: () => void
  setTool: (tool: DrawTool) => void
  setSnapping: (snapping: boolean) => void
  /** Новый объект или загруженный с карты: черновик и значения формы. */
  open: (
    target: EditTarget,
    geometry: FeatureGeometry | null,
    values: Record<string, unknown>,
  ) => void
  /** Отменить черновик: объект не выбран, инструмент — выбор. */
  discard: () => void
  setGeometry: (geometry: FeatureGeometry | null) => void
  /** Шаг назад или вперёд по истории черновика; undefined — шагать некуда. */
  undo: () => FeatureGeometry | null | undefined
  redo: () => FeatureGeometry | null | undefined
  setValues: (values: Record<string, unknown>, auto?: boolean) => void
  setGhost: (ghost: Ghost | null) => void
  setTab: (tab: EditState['tab']) => void
  setController: (controller: DrawController | null) => void
}

export type EditStore = EditState & EditActions

/** Шагов отмены в черновике — больше не хранится. */
const HISTORY_LIMIT = 50

const IDLE: Omit<EditState, 'layerId' | 'snapping' | 'controller'> = {
  past: [],
  future: [],
  tool: 'select',
  target: null,
  geometry: null,
  multi: false,
  values: {},
  autoTerritory: false,
  ghost: null,
  tab: 'feature',
}

function createEditStore() {
  return create<EditStore>((set, get) => ({
    ...IDLE,
    layerId: null,
    snapping: true,
    controller: null,
    start: (layerId) => set({ ...IDLE, layerId }),
    stop: () => set({ ...IDLE, layerId: null }),
    setTool: (tool) => set({ tool }),
    setSnapping: (snapping) => set({ snapping }),
    open: (target, geometry, values) =>
      set({
        target,
        geometry,
        multi: Boolean(geometry?.type.startsWith('Multi')),
        values,
        autoTerritory: false,
        tool: 'select',
        ghost: null,
        tab: 'feature',
        past: [],
        future: [],
      }),
    discard: () => set({ ...IDLE }),
    setGeometry: (geometry) =>
      set((state) =>
        JSON.stringify(state.geometry) === JSON.stringify(geometry)
          ? {}
          : {
              geometry,
              past: [...state.past, state.geometry].slice(-HISTORY_LIMIT),
              future: [],
            },
      ),
    undo: () => {
      const { past, future, geometry } = get()
      if (past.length === 0) return undefined
      const previous = past[past.length - 1] ?? null
      set({ geometry: previous, past: past.slice(0, -1), future: [geometry, ...future] })
      return previous
    },
    redo: () => {
      const { past, future, geometry } = get()
      if (future.length === 0) return undefined
      const next = future[0] ?? null
      set({ geometry: next, past: [...past, geometry], future: future.slice(1) })
      return next
    },
    setValues: (values, auto) =>
      set((state) => ({ values, autoTerritory: auto ?? state.autoTerritory })),
    setGhost: (ghost) => set({ ghost }),
    setTab: (tab) => set({ tab }),
    setController: (controller) => set({ controller }),
  }))
}

const stores = new Map<string, UseBoundStore<StoreApi<EditStore>>>()

/** Хранилище сеанса правки карты: одно на карту-студию. */
export function editStore(mapId: string): UseBoundStore<StoreApi<EditStore>> {
  let store = stores.get(mapId)
  if (!store) {
    store = createEditStore()
    stores.set(mapId, store)
  }
  return store
}

/** Студия закрыта — сеанс правки забыт. */
export function disposeEditStore(mapId: string): void {
  stores.delete(mapId)
}
