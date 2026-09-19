import { create } from 'zustand'
import type { Invitee } from './people-picker.js'

/**
 * Заготовка события вне экрана календаря: быстрое создание из палитры
 * («Встреча завтра в 10 с Ивановым») открывает календарь с формой.
 */
export interface EventDraft {
  title?: string
  /** Моменты начала и конца (мс). */
  start?: number
  end?: number
  allDay?: boolean
  /** Дата события на весь день. */
  date?: string
  calendarId?: string
  /** Фамилии, которых нужно найти среди сотрудников и пригласить. */
  people?: string[]
  /** Уже выбранные участники и ресурсы («Найти время» до создания события). */
  attendees?: Invitee[]
  resourceIds?: string[]
}

interface CalendarUiState {
  draft: EventDraft | null
  openDraft: (draft: EventDraft) => void
  takeDraft: () => EventDraft | null
}

export const useCalendarUi = create<CalendarUiState>((set, get) => ({
  draft: null,
  openDraft: (draft) => set({ draft }),
  takeDraft: () => {
    const draft = get().draft
    if (draft) set({ draft: null })
    return draft
  },
}))
