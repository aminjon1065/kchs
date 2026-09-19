import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { type EventDraft, useCalendarUi } from './calendar-store.js'
import { useCalendarFormat } from './format.js'
import { calendarSettingsQuery } from './queries.js'
import { parseQuickEvent, vocabFrom } from './quick-parse.js'
import { addDays, instantAt, MINUTE_MS, todayIn } from './time.js'

export interface QuickEventCommand {
  /** «Создать событие «Встреча»». */
  label: string
  /** Когда и с кем: «Завтра, 10:00–11:00 · Иванов». */
  hint: string
  run: () => void
}

/**
 * Быстрое создание события из палитры команд: фраза с датой или временем
 * («Встреча завтра в 10 с Ивановым») превращается в заготовку, календарь
 * открывается с формой — участники находятся по фамилии.
 */
export function useQuickEvent(text: string): QuickEventCommand | null {
  const t = useT()
  const format = useCalendarFormat()
  const tz = format.timezone
  const openTab = useWorkspace((s) => s.openTab)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  const openDraft = useCalendarUi((s) => s.openDraft)
  const { data: settings } = useQuery({
    ...calendarSettingsQuery(),
    enabled: text.trim().length > 2,
  })
  const vocab = useMemo(() => vocabFrom(t), [t])

  return useMemo(() => {
    if (text.trim().length < 3) return null
    const today = todayIn(tz)
    const parsed = parseQuickEvent(text, today, vocab)
    if (!parsed?.date) return null
    const duration = (settings?.defaultDurationMinutes ?? 60) * MINUTE_MS
    let draft: EventDraft
    let when: string
    if (parsed.allDay || parsed.start === null) {
      draft = { title: parsed.title, allDay: true, date: parsed.date, people: parsed.people }
      when = format.when({
        startsAt: new Date(instantAt(parsed.date, 0, tz)).toISOString(),
        endsAt: new Date(instantAt(addDays(parsed.date, 1), 0, tz)).toISOString(),
        allDay: true,
        startDate: parsed.date,
        endDate: parsed.date,
      })
    } else {
      const start = instantAt(parsed.date, parsed.start, tz)
      const end =
        parsed.end !== null && parsed.end > parsed.start
          ? instantAt(parsed.date, parsed.end, tz)
          : start + duration
      draft = { title: parsed.title, start, end, people: parsed.people }
      when = format.when({
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        allDay: false,
        startDate: null,
        endDate: null,
      })
    }
    return {
      label: t('calendar.quick.create', { title: parsed.title }),
      hint: parsed.people.length ? `${when} · ${parsed.people.join(', ')}` : when,
      run: () => {
        openDraft(draft)
        setNavigatorModule('calendar')
        openTab({
          kind: 'screen',
          screen: 'calendar',
          title: t('shell.rail.calendar'),
          icon: 'calendar',
          mode: 'permanent',
        })
      },
    }
  }, [
    text,
    tz,
    vocab,
    settings?.defaultDurationMinutes,
    format,
    t,
    openDraft,
    openTab,
    setNavigatorModule,
  ])
}
