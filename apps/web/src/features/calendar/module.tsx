import { CalendarDays, CalendarPlus } from 'lucide-react'
import { useT } from '~/shared/i18n.js'
import type {
  ModuleDefinition,
  PaletteCommand,
  PaletteQuickAction,
} from '~/shared/workspace/registry.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { useCalendarUi } from './calendar-store.js'
import { useQuickEvent } from './quick-create.js'

/** «Встреча завтра в 10 с Ивановым» — событие из палитры (ADR-0081). */
function usePaletteQuickAction(query: string): PaletteQuickAction | null {
  const quick = useQuickEvent(query)
  if (!quick) return null
  return {
    groupKey: 'calendar.quick.group',
    icon: <CalendarPlus />,
    label: quick.label,
    hint: quick.hint,
    run: quick.run,
  }
}

/** Команда палитры «Новое событие»: форма события на экране календаря. */
function usePaletteCommands(): PaletteCommand[] {
  const t = useT()
  const openDraft = useCalendarUi((s) => s.openDraft)
  const openTab = useWorkspace((s) => s.openTab)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  return [
    {
      id: 'new-event',
      label: t('calendar.quick.newEvent'),
      icon: <CalendarPlus />,
      run: () => {
        openDraft({})
        setNavigatorModule('calendar')
        openTab({
          kind: 'screen',
          screen: 'calendar',
          title: t('shell.rail.calendar'),
          icon: 'calendar',
          mode: 'permanent',
        })
      },
    },
  ]
}

/** Что модуль «Календарь» даёт оболочке (ADR-0183). */
export const calendarModule: ModuleDefinition = {
  key: 'calendar',
  namespaces: ['calendar'],
  nav: [
    {
      key: 'calendar',
      icon: CalendarDays,
      labelKey: 'shell.rail.calendar',
      tabIcon: 'calendar',
      order: 100,
    },
  ],
  extensions: { usePaletteQuickAction, usePaletteCommands },
}
