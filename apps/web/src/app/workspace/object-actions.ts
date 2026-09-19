import { create } from 'zustand'

/**
 * Действие дела Входящих, которое выполняется формой в карточке объекта
 * (`InboxAction.openObject`, ADR-0084): Входящие открывают вкладку объекта и
 * оставляют здесь ключ действия; представление объекта забирает его один раз
 * и показывает нужную форму (резолюция документа). В сохранённое состояние
 * вкладок не попадает — это намерение, а не состояние.
 */
interface ObjectActionsState {
  pending: Record<string, string>
  request: (objectId: string, action: string) => void
  /** Забрать действие объекта: вернуть ключ и снять его. */
  take: (objectId: string) => string | null
}

export const useObjectActions = create<ObjectActionsState>()((set, get) => ({
  pending: {},
  request: (objectId, action) => set({ pending: { ...get().pending, [objectId]: action } }),
  take: (objectId) => {
    const action = get().pending[objectId] ?? null
    if (action) {
      const { [objectId]: _, ...rest } = get().pending
      set({ pending: rest })
    }
    return action
  },
}))
