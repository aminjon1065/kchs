import type { MeetingJoin, MeetingRecord, MeetingSignal } from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  ObjectIcon,
  Spinner,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Circle, MonitorUp } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { objectLinksQuery } from '~/shared/api/queries.js'
import { meetingKeys } from '../queries.js'
import { RoomControls, type RoomLayout, type SidePanel } from './controls.js'
import { RoomAudio, VideoTile } from './media.js'
import type { DevicePrefs } from './prejoin.js'
import { MeetingChat, PeoplePanel } from './side-panel.js'
import { type RoomTile, useMeetingRoom } from './use-meeting-room.js'

export interface MeetingRoomProps {
  title: string
  /**
   * Карточка встречи — только участнику системы. У гостя по ссылке её нет:
   * ни чата, ни списка приглашённых, ни объектов (ADR-0091).
   */
  meeting: MeetingRecord | null
  join: MeetingJoin
  /** Новый токен: срок прежнего истёк или соединение потеряно. */
  refreshToken: () => Promise<MeetingJoin>
  onLeave: () => void
  onEnd?: () => void
  /** «Показать всем»: получатель открывает объект своими правами. */
  onShow?: (object: { objectId: string; objectType: string; title: string }) => void
  /** Устройства и с чем войти — из проверки перед входом (ADR-0162). */
  prefs?: DevicePrefs | null
}

/**
 * Комната встречи (11-communications-meetings.md §3, ADR-0091): сетка,
 * докладчик и боковая раскладка, устройства, демонстрация экрана, рука,
 * реакции, качество сети, индикатор записи, участники и чат встречи.
 */
export function MeetingRoom({
  title,
  meeting,
  join,
  refreshToken,
  onLeave,
  onEnd,
  onShow,
  prefs = null,
}: MeetingRoomProps) {
  const guest = meeting === null
  const t = useT()
  const toast = useToast()
  const [layout, setLayout] = useState<RoomLayout>('grid')
  const [panel, setPanel] = useState<SidePanel>('none')
  const [showOpen, setShowOpen] = useState(false)
  const client = useQueryClient()

  // Запись встречи (ADR-0092): состояние ведёт сервер, индикатор — у всех
  const active = meeting?.recording ?? null
  const record = useMutation({
    mutationFn: async () => {
      if (active) await http.post(`/recordings/${active.id}/stop`)
      else await http.post(`/meetings/${meeting?.id}/recording/start`)
    },
    onSuccess: () => {
      if (meeting) void client.invalidateQueries({ queryKey: meetingKeys.meeting(meeting.id) })
    },
    onError: () => toast.error(t('meetings.errors.recordFailed')),
  })

  const onSignal = useCallback(
    (signal: MeetingSignal) => {
      if (signal.type !== 'show') return
      onShow?.({
        objectId: signal.objectId,
        objectType: signal.objectType,
        title: signal.title,
      })
    },
    [onShow],
  )

  const room = useMeetingRoom({
    join,
    refreshToken,
    onSignal,
    startWithVideo: meeting?.kind === 'call',
    prefs,
  })

  const stage = useMemo(() => pickStage(room.tiles), [room.tiles])
  const others = room.tiles.filter((tile) => tile.key !== stage?.key)

  const leave = () => {
    room.disconnect()
    onLeave()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" data-testid="meeting-room">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="truncate text-sm font-medium">{title}</span>
        {room.recording || active ? (
          <Badge tone="danger" size="sm" data-testid="meeting-recording">
            <Circle className="size-2 fill-current" aria-hidden />
            {t('meetings.room.recording')}
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-fg-secondary">
          {room.state === 'connecting' ? <Spinner className="size-3.5" /> : null}
          {t(`meetings.state.${room.state}`)}
        </span>
      </header>

      {room.state === 'error' || room.state === 'disconnected' ? (
        <Callout tone={room.state === 'error' ? 'danger' : 'warning'} className="m-3">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              {room.state === 'error' ? t('meetings.room.failed') : t('meetings.room.dropped')}
            </span>
            <Button size="sm" onClick={room.reconnect} data-testid="meeting-reconnect">
              {t('meetings.room.reconnect')}
            </Button>
          </div>
        </Callout>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2">
          {layout === 'grid' ? (
            <div
              className={cn(
                'grid min-h-0 flex-1 gap-2',
                room.tiles.length <= 1
                  ? 'grid-cols-1'
                  : room.tiles.length <= 4
                    ? 'grid-cols-2'
                    : 'grid-cols-3',
              )}
            >
              {room.tiles.map((tile) => (
                <VideoTile key={tile.key} tile={tile} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 gap-2">
              <div className="min-h-0 min-w-0 flex-1">
                {stage ? (
                  <VideoTile tile={stage} size="stage" />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-fg-muted">
                    {t('meetings.room.nobody')}
                  </div>
                )}
              </div>
              <div
                className={cn(
                  'flex gap-2 overflow-auto',
                  layout === 'sidebar' ? 'w-36 flex-col' : 'hidden',
                )}
              >
                {others.map((tile) => (
                  <VideoTile key={tile.key} tile={tile} size="strip" />
                ))}
              </div>
            </div>
          )}

          {layout === 'speaker' && others.length > 0 ? (
            <div className="flex shrink-0 gap-2 overflow-x-auto">
              {others.map((tile) => (
                <VideoTile key={tile.key} tile={tile} size="strip" />
              ))}
            </div>
          ) : null}
        </div>

        {panel !== 'none' && meeting ? (
          <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface">
            {panel === 'people' ? (
              <PeoplePanel meeting={meeting} room={room} />
            ) : (
              <MeetingChat meetingId={meeting.id} />
            )}
          </aside>
        ) : null}
      </div>

      <RoomAudio tiles={room.tiles} />

      <RoomControls
        room={room}
        layout={layout}
        onLayout={setLayout}
        panel={guest ? 'none' : panel}
        onPanel={setPanel}
        canPanels={!guest}
        canShowToAll={!guest}
        onShowToAll={() => setShowOpen(true)}
        canRecord={Boolean(meeting?.can.record)}
        recording={Boolean(active)}
        recordPending={record.isPending}
        onRecord={() => record.mutate()}
        canEnd={Boolean(onEnd) && Boolean(meeting?.can.end)}
        onEnd={() => onEnd?.()}
        onLeave={leave}
      />

      {meeting ? (
        <ShowToAllDialog
          open={showOpen}
          onOpenChange={setShowOpen}
          meetingId={meeting.id}
          onPick={(object) => {
            room.showToAll(object)
            setShowOpen(false)
            toast.show({ title: t('meetings.room.shown', { title: object.title }) })
          }}
        />
      ) : null}
    </div>
  )
}

/** На сцену — демонстрация экрана, иначе говорящий, иначе первый удалённый. */
function pickStage(tiles: RoomTile[]): RoomTile | null {
  return (
    tiles.find((tile) => tile.isScreen) ??
    tiles.find((tile) => tile.speaking && !tile.isLocal) ??
    tiles.find((tile) => !tile.isLocal) ??
    tiles[0] ??
    null
  )
}

/**
 * «Показать всем» (11-communications-meetings.md §3): участник выбирает
 * связанный со встречей объект, у остальных он открывается вкладкой. Доступ
 * проверяется у получателя — сигнал прав не даёт.
 */
function ShowToAllDialog({
  open,
  onOpenChange,
  meetingId,
  onPick,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  meetingId: string
  onPick: (object: { objectId: string; objectType: string; title: string }) => void
}) {
  const t = useT()
  const { data } = useQuery({ ...objectLinksQuery(meetingId), enabled: open })
  const items = (data?.links ?? []).map((link) => link.object)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('meetings.room.showToAll')} size="sm">
        <p className="text-sm text-fg-secondary">{t('meetings.room.showToAllHint')}</p>
        <div className="mt-3 flex flex-col gap-1">
          {items.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('meetings.room.noLinked')}</p>
          ) : (
            items.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className="justify-start"
                onClick={() =>
                  onPick({ objectId: item.id, objectType: item.type, title: item.title })
                }
              >
                <ObjectIcon type={item.type} className="size-4" />
                <span className="truncate">{item.title}</span>
              </Button>
            ))
          )}
        </div>
        <p className="mt-3 flex items-center gap-2 text-xs text-fg-muted">
          <MonitorUp className="size-3.5" aria-hidden />
          {t('meetings.room.showToAllNote')}
        </p>
      </DialogContent>
    </Dialog>
  )
}
