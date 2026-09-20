import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from '@kchs/ui'
import {
  Circle,
  Columns2,
  Hand,
  LayoutGrid,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Presentation,
  ScreenShare,
  Settings2,
  Smile,
  Users,
  Video,
  VideoOff,
} from 'lucide-react'
import { useT } from '~/app/i18n.js'
import type { MeetingRoomApi } from './use-meeting-room.js'

export type RoomLayout = 'grid' | 'speaker' | 'sidebar'
export type SidePanel = 'none' | 'people' | 'chat'

/** Набор реакций комнаты — тот же, что у сообщений чата. */
const REACTIONS = ['👍', '👏', '😀', '🎉', '❤️', '😮']

/**
 * Нижняя панель комнаты (11-communications-meetings.md §3): микрофон, камера,
 * демонстрация экрана, рука, реакции, раскладка и выход.
 */
export function RoomControls({
  room,
  layout,
  onLayout,
  panel,
  onPanel,
  canPanels,
  canShowToAll,
  onShowToAll,
  canRecord,
  recording,
  recordPending,
  onRecord,
  canEnd,
  onEnd,
  onLeave,
}: {
  room: MeetingRoomApi
  layout: RoomLayout
  onLayout: (next: RoomLayout) => void
  panel: SidePanel
  onPanel: (next: SidePanel) => void
  /** Участники и чат встречи — только своим: у гостя доступа к ним нет. */
  canPanels: boolean
  canShowToAll: boolean
  onShowToAll: () => void
  /** Запись ведёт тот, кто ведёт встречу и имеет способность `meetings.record`. */
  canRecord: boolean
  recording: boolean
  recordPending: boolean
  onRecord: () => void
  canEnd: boolean
  onEnd: () => void
  onLeave: () => void
}) {
  const t = useT()

  return (
    <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-2">
        <Tooltip content={room.micOn ? t('meetings.room.muteMic') : t('meetings.room.unmuteMic')}>
          <Button
            variant={room.micOn ? 'secondary' : 'danger'}
            size="sm"
            onClick={room.toggleMic}
            data-testid="meeting-mic"
            aria-pressed={room.micOn}
          >
            {room.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
          </Button>
        </Tooltip>

        <Tooltip content={room.camOn ? t('meetings.room.stopCam') : t('meetings.room.startCam')}>
          <Button
            variant={room.camOn ? 'secondary' : 'danger'}
            size="sm"
            onClick={room.toggleCam}
            data-testid="meeting-cam"
            aria-pressed={room.camOn}
          >
            {room.camOn ? <Video className="size-4" /> : <VideoOff className="size-4" />}
          </Button>
        </Tooltip>

        <DeviceMenu room={room} />

        <Tooltip content={t('meetings.room.share')}>
          <Button
            variant={room.sharing ? 'primary' : 'secondary'}
            size="sm"
            onClick={room.toggleShare}
            data-testid="meeting-share"
            aria-pressed={room.sharing}
          >
            <ScreenShare className="size-4" />
          </Button>
        </Tooltip>

        <Tooltip content={t('meetings.room.raiseHand')}>
          <Button
            variant={room.handRaised ? 'primary' : 'secondary'}
            size="sm"
            onClick={room.toggleHand}
            data-testid="meeting-hand"
            aria-pressed={room.handRaised}
          >
            <Hand className="size-4" />
          </Button>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" aria-label={t('meetings.room.reactions')}>
              <Smile className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <div className="flex gap-1 p-1">
              {REACTIONS.map((emoji) => (
                <IconButton
                  key={emoji}
                  label={emoji}
                  size="sm"
                  onClick={() => room.sendReaction(emoji)}
                >
                  <span aria-hidden>{emoji}</span>
                </IconButton>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {canRecord ? (
          <Tooltip
            content={
              recording ? t('meetings.room.stopRecording') : t('meetings.room.startRecording')
            }
          >
            <Button
              variant={recording ? 'danger' : 'secondary'}
              size="sm"
              onClick={onRecord}
              loading={recordPending}
              data-testid="meeting-record"
              aria-pressed={recording}
              aria-label={
                recording ? t('meetings.room.stopRecording') : t('meetings.room.startRecording')
              }
            >
              <Circle className={cn('size-4', recording && 'fill-current')} />
            </Button>
          </Tooltip>
        ) : null}

        {canShowToAll ? (
          <Tooltip content={t('meetings.room.showToAllHint')}>
            <Button variant="secondary" size="sm" onClick={onShowToAll} data-testid="meeting-show">
              <MonitorUp className="size-4" />
              <span className="hidden sm:inline">{t('meetings.room.showToAll')}</span>
            </Button>
          </Tooltip>
        ) : null}

        <div className="mx-1 h-6 w-px bg-line" aria-hidden />

        <LayoutButton
          active={layout === 'grid'}
          label={t('meetings.layout.grid')}
          onClick={() => onLayout('grid')}
        >
          <LayoutGrid className="size-4" />
        </LayoutButton>
        <LayoutButton
          active={layout === 'speaker'}
          label={t('meetings.layout.speaker')}
          onClick={() => onLayout('speaker')}
        >
          <Presentation className="size-4" />
        </LayoutButton>
        <LayoutButton
          active={layout === 'sidebar'}
          label={t('meetings.layout.sidebar')}
          onClick={() => onLayout('sidebar')}
        >
          <Columns2 className="size-4" />
        </LayoutButton>

        {canPanels ? (
          <>
            <div className="mx-1 h-6 w-px bg-line" aria-hidden />
            <LayoutButton
              active={panel === 'people'}
              label={t('meetings.room.people')}
              onClick={() => onPanel(panel === 'people' ? 'none' : 'people')}
            >
              <Users className="size-4" />
            </LayoutButton>
            <LayoutButton
              active={panel === 'chat'}
              label={t('meetings.room.chat')}
              onClick={() => onPanel(panel === 'chat' ? 'none' : 'chat')}
            >
              <MessageSquare className="size-4" />
            </LayoutButton>
          </>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canEnd ? (
          <Button variant="ghost" size="sm" onClick={onEnd} data-testid="meeting-end">
            {t('meetings.room.endForAll')}
          </Button>
        ) : null}
        <Button variant="danger" size="sm" onClick={onLeave} data-testid="meeting-leave">
          <PhoneOff className="size-4" />
          {t('meetings.room.leave')}
        </Button>
      </div>
    </div>
  )
}

function LayoutButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'flex size-8 items-center justify-center rounded-md',
          active ? 'bg-accent-subtle text-accent' : 'text-fg-secondary hover:bg-surface-3',
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** Выбор устройств: камера, микрофон и вывод звука. */
function DeviceMenu({ room }: { room: MeetingRoomApi }) {
  const t = useT()
  const kinds: Array<{ kind: MediaDeviceKind; label: string }> = [
    { kind: 'audioinput', label: t('meetings.devices.microphone') },
    { kind: 'videoinput', label: t('meetings.devices.camera') },
    { kind: 'audiooutput', label: t('meetings.devices.speaker') },
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" aria-label={t('meetings.devices.title')}>
          <Settings2 className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-w-80">
        {kinds.map(({ kind, label }, index) => {
          const list = room.devices[kind as keyof typeof room.devices] ?? []
          return (
            <div key={kind}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{label}</DropdownMenuLabel>
              {list.length === 0 ? (
                <DropdownMenuItem disabled>{t('meetings.devices.empty')}</DropdownMenuItem>
              ) : (
                list.map((device) => (
                  <DropdownMenuItem
                    key={device.deviceId}
                    onSelect={() => room.selectDevice(kind, device.deviceId)}
                  >
                    <span className="truncate">
                      {device.label || t('meetings.devices.unnamed')}
                    </span>
                    {room.activeDevices[kind] === device.deviceId ? (
                      <span className="ml-auto text-accent" aria-hidden>
                        •
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))
              )}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
