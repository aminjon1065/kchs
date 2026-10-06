import { useToast } from '@kchs/ui'
import { useEffect } from 'react'
import { useT } from '~/shared/i18n.js'
import { onRealtimeEvent } from '~/shared/realtime/client.js'
import { useWorkspace } from '~/shared/workspace/store.js'

/**
 * Сообщения встреч вне комнаты (ADR-0193): звонящему — что приглашённый отклонил звонок,
 * ведущему — что гость ждёт в комнате ожидания. У кого встреча на экране, тот видит заявку
 * в самой комнате, и второй раз о ней не сообщается.
 */
export function MeetingSignals() {
  const t = useT()
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)

  useEffect(
    () =>
      onRealtimeEvent('call.declined', ({ user }) => {
        toast.show({
          title: t('meetings.call.declined', {
            name: user?.displayName ?? t('meetings.call.unknownCaller'),
          }),
          tone: 'info',
        })
      }),
    [t, toast],
  )

  useEffect(
    () =>
      onRealtimeEvent('meeting.guest_waiting', ({ meetingId, name, title }) => {
        if (meetingOnScreen(meetingId)) return
        toast.show({
          title: t('meetings.waiting.guestToast', { name }),
          description: title,
          tone: 'info',
          action: {
            label: t('meetings.waiting.open'),
            onClick: () => {
              openTab({
                kind: 'object',
                objectId: meetingId,
                objectType: 'meeting',
                title,
                mode: 'permanent',
              })
            },
          },
        })
      }),
    [t, toast, openTab],
  )

  return null
}

/** Встреча видна: она — активная вкладка одной из панелей. */
function meetingOnScreen(meetingId: string): boolean {
  const { panes, tabs } = useWorkspace.getState()
  return panes.some((pane) => {
    const tab = pane.activeTabId ? tabs[pane.activeTabId] : undefined
    return tab?.kind === 'object' && tab.objectId === meetingId
  })
}
