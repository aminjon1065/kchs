import { Video } from 'lucide-react'
import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { IncomingCallOverlay } from './incoming-call.js'

/** Что модуль встреч даёт оболочке (ADR-0183): пункт навигации и входящий звонок. */
export const meetingsModule: ModuleDefinition = {
  key: 'meetings',
  nav: [
    {
      key: 'meetings',
      icon: Video,
      labelKey: 'shell.rail.meetings',
      tabIcon: 'meetings',
      order: 80,
    },
  ],
  slots: [{ key: 'incoming-call', placement: 'overlay', render: () => <IncomingCallOverlay /> }],
}
