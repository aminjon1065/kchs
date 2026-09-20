import type { IncomingCall } from '@kchs/contracts'
import { Avatar, Button, Dialog, DialogContent } from '@kchs/ui'
import { Phone, PhoneOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { onRealtimeEvent } from '~/shared/realtime/client.js'
import { declineCall } from './queries.js'

/**
 * Входящий звонок (P4-E02 S03, ADR-0091): событие `call.incoming` приходит
 * realtime приглашённому, экран предлагает принять или отклонить. Принятый
 * звонок открывает вкладку встречи — дальше работает обычная комната.
 */
export function IncomingCallOverlay() {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const [call, setCall] = useState<IncomingCall | null>(null)

  useEffect(
    () =>
      onRealtimeEvent('call.incoming', (payload) => {
        const incoming = payload as IncomingCall
        if (!incoming?.meetingId) return
        setCall(incoming)
      }),
    [],
  )

  // Звонок мог закончиться раньше ответа: комнату закрыли — экран убираем
  useEffect(
    () =>
      onRealtimeEvent('meeting.changed', (payload) => {
        const changed = payload as { meetingId?: string; change?: string }
        if (changed.change === 'ended') {
          setCall((current) => (current?.meetingId === changed.meetingId ? null : current))
        }
      }),
    [],
  )

  if (!call) return null

  const accept = (): void => {
    openTab({
      kind: 'object',
      objectId: call.meetingId,
      objectType: 'meeting',
      title: call.title,
      mode: 'permanent',
    })
    setCall(null)
  }

  const decline = (): void => {
    void declineCall(call.meetingId).catch(() => undefined)
    setCall(null)
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : setCall(null))}>
      <DialogContent
        title={t('meetings.call.incoming')}
        size="sm"
        data-testid="incoming-call"
        hideClose
      >
        <div className="flex items-center gap-3">
          <Avatar
            name={call.caller?.displayName ?? call.title}
            src={call.caller?.avatarUrl}
            size="lg"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {call.caller?.displayName ?? t('meetings.call.unknownCaller')}
            </p>
            <p className="truncate text-xs text-fg-secondary">{call.title}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="danger"
            onClick={decline}
            data-testid="call-decline"
            icon={<PhoneOff className="size-4" />}
          >
            {t('meetings.call.decline')}
          </Button>
          <Button
            variant="primary"
            onClick={accept}
            data-testid="call-accept"
            icon={<Phone className="size-4" />}
          >
            {t('meetings.call.accept')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
