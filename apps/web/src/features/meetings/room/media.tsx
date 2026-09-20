import { Avatar, Badge, cn } from '@kchs/ui'
import { Track } from 'livekit-client'
import { Hand, MicOff, ScreenShare, SignalHigh, SignalLow, SignalMedium } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useT } from '~/app/i18n.js'
import type { Quality, RoomTile } from './use-meeting-room.js'

/**
 * Плитка участника: дорожка привязывается к элементу императивно — так делает
 * сам `livekit-client`, React только владеет разметкой (ADR-0091).
 */
export function VideoTile({
  tile,
  size = 'grid',
}: {
  tile: RoomTile
  size?: 'grid' | 'stage' | 'strip'
}) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const track = tile.publication?.track ?? null

  useEffect(() => {
    const element = videoRef.current
    if (!element || !track) return
    track.attach(element)
    return () => {
      track.detach(element)
    }
  }, [track])

  const live = Boolean(track) && !(tile.publication?.isMuted ?? true)

  return (
    <div
      data-testid="meeting-tile"
      data-identity={tile.identity}
      className={cn(
        'relative flex min-h-0 items-center justify-center overflow-hidden rounded-lg bg-surface-3',
        tile.speaking && !tile.isScreen && 'ring-2 ring-accent',
        size === 'strip' && 'h-24 w-32 shrink-0',
        size === 'stage' && 'h-full w-full',
      )}
    >
      {live ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Своё видео беззвучно всегда: иначе эхо
          muted
          className={cn('h-full w-full', tile.isScreen ? 'object-contain' : 'object-cover')}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 p-3">
          <Avatar name={tile.name} size={size === 'strip' ? 'sm' : 'lg'} />
          {size === 'grid' || size === 'stage' ? (
            <span className="max-w-40 truncate text-xs text-fg-secondary">{tile.name}</span>
          ) : null}
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-1 bottom-1 flex items-center gap-1">
        <span className="truncate rounded bg-surface/80 px-1.5 py-0.5 text-2xs text-fg">
          {tile.isScreen ? t('meetings.room.screenOf', { name: tile.name }) : tile.name}
        </span>
        {tile.guest ? (
          <Badge tone="neutral" size="sm">
            {t('meetings.room.guestTag')}
          </Badge>
        ) : null}
        {!tile.isScreen && !tile.micOn ? (
          <MicOff className="size-3.5 text-danger" aria-label={t('meetings.room.micOff')} />
        ) : null}
        {tile.isScreen ? <ScreenShare className="size-3.5 text-accent" aria-hidden /> : null}
        <span className="ml-auto">
          <QualityIcon quality={tile.quality} />
        </span>
      </div>

      {tile.hand && !tile.isScreen ? (
        <div className="absolute left-1 top-1 rounded bg-warning-subtle px-1 py-0.5 text-warning">
          <Hand className="size-3.5" aria-label={t('meetings.room.handRaised')} />
        </div>
      ) : null}
      {tile.reaction && !tile.isScreen ? (
        <span className="absolute right-2 top-1 text-2xl" aria-hidden>
          {tile.reaction}
        </span>
      ) : null}
    </div>
  )
}

/** Показатель качества сети участника (11-communications-meetings.md §3). */
export function QualityIcon({ quality }: { quality: Quality }) {
  const t = useT()
  const label = t(`meetings.quality.${quality}`)
  if (quality === 'excellent' || quality === 'good') {
    return <SignalHigh className="size-3.5 text-success" aria-label={label} />
  }
  if (quality === 'poor')
    return <SignalMedium className="size-3.5 text-warning" aria-label={label} />
  if (quality === 'lost') return <SignalLow className="size-3.5 text-danger" aria-label={label} />
  return <SignalLow className="size-3.5 text-fg-muted" aria-label={label} />
}

/**
 * Звук удалённых участников: дорожки надо привязать к элементу, иначе их не
 * слышно. Элементы скрыты — на экране их место занимает плитка.
 */
export function RoomAudio({ tiles }: { tiles: RoomTile[] }) {
  return (
    <div className="hidden">
      {tiles
        .filter((tile) => !tile.isLocal && !tile.isScreen)
        .map((tile) => (
          <RemoteAudio key={tile.identity} tile={tile} />
        ))}
    </div>
  )
}

function RemoteAudio({ tile }: { tile: RoomTile }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const audio = tile.audioPublication?.track ?? null

  useEffect(() => {
    const element = ref.current
    if (!element || !audio) return
    audio.attach(element)
    return () => {
      audio.detach(element)
    }
  }, [audio])

  return (
    <audio ref={ref} autoPlay data-source={Track.Source.Microphone}>
      <track kind="captions" />
    </audio>
  )
}
