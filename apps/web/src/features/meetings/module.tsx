import { Video } from 'lucide-react'
import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { IncomingCallOverlay } from './incoming-call.js'
import { MeetingSignals } from './meeting-signals.js'

/**
 * Что модуль встреч даёт оболочке (ADR-0183): пункт навигации, входящий звонок и сообщения
 * вне комнаты — отказ от звонка и гость в комнате ожидания (ADR-0193).
 */
export const meetingsModule: ModuleDefinition = {
  key: 'meetings',
  namespaces: ['meetings'],
  nav: [
    {
      key: 'meetings',
      icon: Video,
      labelKey: 'shell.rail.meetings',
      tabIcon: 'meetings',
      order: 80,
    },
  ],
  slots: [
    { key: 'incoming-call', placement: 'overlay', render: () => <IncomingCallOverlay /> },
    { key: 'meeting-signals', placement: 'overlay', render: () => <MeetingSignals /> },
  ],
}
