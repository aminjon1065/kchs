import type { MeetingJoin, MeetingSignal } from '@kchs/contracts'
import {
  ConnectionQuality,
  type Participant,
  type RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
} from 'livekit-client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DevicePrefs } from './prejoin.js'

/**
 * Клиент комнаты встречи (11-communications-meetings.md §3, ADR-0091): свой
 * интерфейс поверх `livekit-client`. Медиапоток идёт мимо api, поэтому всё,
 * что знает комната, — токен участника; права в нём выпустил сервер.
 */
export type RoomState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'

export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

export interface RoomTile {
  /** Устойчивый ключ плитки: участник и вид дорожки. */
  key: string
  identity: string
  name: string
  isLocal: boolean
  isScreen: boolean
  publication: TrackPublication | null
  /** Дорожка звука участника: её привязывает отдельный элемент. */
  audioPublication: TrackPublication | null
  speaking: boolean
  micOn: boolean
  camOn: boolean
  quality: Quality
  hand: boolean
  reaction: string | null
  guest: boolean
}

export interface DeviceState {
  audioinput: MediaDeviceInfo[]
  videoinput: MediaDeviceInfo[]
  audiooutput: MediaDeviceInfo[]
}

const EMPTY_DEVICES: DeviceState = { audioinput: [], videoinput: [], audiooutput: [] }

/** Реакция живёт на экране недолго — как в мессенджерах. */
const REACTION_MS = 5000

function qualityOf(participant: Participant): Quality {
  switch (participant.connectionQuality) {
    case ConnectionQuality.Excellent:
      return 'excellent'
    case ConnectionQuality.Good:
      return 'good'
    case ConnectionQuality.Poor:
      return 'poor'
    case ConnectionQuality.Lost:
      return 'lost'
    default:
      return 'unknown'
  }
}

function isGuest(participant: Participant): boolean {
  return participant.identity.startsWith('guest:')
}

export interface MeetingRoomOptions {
  join: MeetingJoin | null
  /** Новый токен для повторного подключения: срок прежнего истекает. */
  refreshToken?: () => Promise<MeetingJoin>
  /** «Показать всем» и прочие сигналы участников по каналу данных. */
  onSignal?: (signal: MeetingSignal, from: string) => void
  /** Войти с включённой камерой: у звонка — да, у большой встречи — нет. */
  startWithVideo?: boolean
  /**
   * Выбор проверки перед входом (ADR-0162): устройства и с чем войти. Задан —
   * важнее `startWithVideo`; менять его после входа нечего — дальше устройства
   * переключает `selectDevice`.
   */
  prefs?: DevicePrefs | null
}

export interface MeetingRoomApi {
  state: RoomState
  error: string | null
  tiles: RoomTile[]
  localIdentity: string
  micOn: boolean
  camOn: boolean
  sharing: boolean
  handRaised: boolean
  recording: boolean
  devices: DeviceState
  activeDevices: Partial<Record<MediaDeviceKind, string>>
  toggleMic: () => void
  toggleCam: () => void
  toggleShare: () => void
  toggleHand: () => void
  sendReaction: (emoji: string) => void
  showToAll: (object: { objectId: string; objectType: string; title: string }) => void
  selectDevice: (kind: MediaDeviceKind, deviceId: string) => void
  reconnect: () => void
  disconnect: () => void
}

export function useMeetingRoom(options: MeetingRoomOptions): MeetingRoomApi {
  const { join, refreshToken, onSignal, startWithVideo = false, prefs = null } = options
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const roomRef = useRef<Room | null>(null)
  /** Токен подключённой комнаты: по нему эффект узнаёт «ту же» комнату. */
  const tokenRef = useRef<string | null>(null)
  const closeTimer = useRef<number | null>(null)
  const signalRef = useRef(onSignal)
  signalRef.current = onSignal

  const [state, setState] = useState<RoomState>('idle')
  const [error, setError] = useState<string | null>(null)
  // Событий у комнаты много, а состояние живёт в объекте `Room`: счётчик
  // пересобирает плитки после любого из них
  const [version, bump] = useState(0)
  const [hands, setHands] = useState<Record<string, boolean>>({})
  const [reactions, setReactions] = useState<Record<string, string>>({})
  const [devices, setDevices] = useState<DeviceState>(EMPTY_DEVICES)
  const [activeDevices, setActiveDevices] = useState<Partial<Record<MediaDeviceKind, string>>>({})
  const [token, setToken] = useState<MeetingJoin | null>(join)

  useEffect(() => setToken(join), [join])

  const refresh = useCallback(() => bump((value) => value + 1), [])

  /**
   * Отключение откладывается: в строгом режиме React эффект выполняется
   * дважды, а второй вход той же личностью заставляет медиасервер «переезжать»
   * и рвёт публикацию дорожек. Пауза даёт повторному проходу вернуть комнату.
   */
  const closeLater = useCallback(() => {
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      const room = roomRef.current
      roomRef.current = null
      tokenRef.current = null
      room?.removeAllListeners()
      void room?.disconnect()
    }, 300)
  }, [])

  // Подключение: комната создаётся один раз на токен — новый токен (гость,
  // переподключение) поднимает новую, состояние прежней с собой не тянет
  useEffect(() => {
    if (!token?.token || !token.url) return
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (roomRef.current && tokenRef.current === token.token) return closeLater

    const chosen = prefsRef.current
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      ...(chosen?.audioDeviceId
        ? { audioCaptureDefaults: { deviceId: chosen.audioDeviceId } }
        : {}),
      ...(chosen?.videoDeviceId
        ? { videoCaptureDefaults: { deviceId: chosen.videoDeviceId } }
        : {}),
    })
    roomRef.current = room
    tokenRef.current = token.token
    /** Комната ещё наша: иначе её сменили новым токеном или закрыли. */
    const current = () => roomRef.current === room

    const onQuality = () => refresh()
    const onData = (payload: Uint8Array, participant?: RemoteParticipant) => {
      if (!participant) return
      let signal: MeetingSignal
      try {
        signal = JSON.parse(new TextDecoder().decode(payload)) as MeetingSignal
      } catch {
        return
      }
      if (signal.type === 'hand') {
        setHands((current) => ({ ...current, [participant.identity]: signal.raised }))
        return
      }
      if (signal.type === 'reaction') {
        setReactions((current) => ({ ...current, [participant.identity]: signal.emoji }))
        window.setTimeout(
          () =>
            setReactions((current) => {
              const { [participant.identity]: _gone, ...rest } = current
              return rest
            }),
          REACTION_MS,
        )
        return
      }
      signalRef.current?.(signal, participant.identity)
    }

    for (const event of [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.RecordingStatusChanged,
      RoomEvent.ParticipantNameChanged,
    ] as const) {
      room.on(event, onQuality)
    }
    room.on(RoomEvent.ConnectionQualityChanged, onQuality)
    room.on(RoomEvent.DataReceived, onData)
    room.on(RoomEvent.MediaDevicesChanged, () => void loadDevices())
    room.on(RoomEvent.Reconnecting, () => current() && setState('reconnecting'))
    room.on(RoomEvent.Reconnected, () => current() && setState('connected'))
    room.on(RoomEvent.Disconnected, () => current() && setState('disconnected'))

    const loadDevices = async (): Promise<void> => {
      try {
        const [audioinput, videoinput, audiooutput] = await Promise.all([
          Room.getLocalDevices('audioinput'),
          Room.getLocalDevices('videoinput'),
          Room.getLocalDevices('audiooutput'),
        ])
        if (current()) setDevices({ audioinput, videoinput, audiooutput })
      } catch {
        // список устройств недоступен без разрешения — не мешает входу
      }
    }

    setState('connecting')
    setError(null)
    void (async () => {
      try {
        await room.connect(token.url, token.token)
        if (!current()) return
        setState('connected')
        // Микрофон включается сразу, камера — по желанию: так вход тише.
        // Публикация не ждётся: при плохой сети она может тянуться долго, а
        // комната должна быть видна сразу — состояние обновят события дорожек
        if (chosen?.mic ?? true) {
          void room.localParticipant
            .setMicrophoneEnabled(true)
            .then(refresh)
            .catch(() => undefined)
        }
        setActiveDevices({
          ...(chosen?.audioDeviceId ? { audioinput: chosen.audioDeviceId } : {}),
          ...(chosen?.videoDeviceId ? { videoinput: chosen.videoDeviceId } : {}),
        })
        if (chosen ? chosen.camera : startWithVideo) {
          void room.localParticipant
            .setCameraEnabled(true)
            .then(refresh)
            .catch(() => undefined)
        }
        await loadDevices()
        refresh()
      } catch (cause) {
        if (!current()) return
        setState('error')
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()

    return closeLater
  }, [token, refresh, startWithVideo, closeLater])

  const publish = useCallback((signal: MeetingSignal) => {
    const room = roomRef.current
    if (!room) return
    const data = new TextEncoder().encode(JSON.stringify(signal))
    void room.localParticipant.publishData(data, { reliable: true }).catch(() => undefined)
  }, [])

  const local = roomRef.current?.localParticipant ?? null
  const localIdentity = local?.identity ?? ''
  const handRaised = hands[localIdentity] ?? false

  // biome-ignore lint/correctness/useExhaustiveDependencies: состояние комнаты живёт в `Room`; `version` и `state` — повод пересобрать плитки
  const tiles = useMemo(() => {
    const room = roomRef.current
    if (!room) return []
    const people: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()]
    const result: RoomTile[] = []
    for (const person of people) {
      const camera = person.getTrackPublication(Track.Source.Camera) ?? null
      const screen = person.getTrackPublication(Track.Source.ScreenShare) ?? null
      const base = {
        audioPublication: person.getTrackPublication(Track.Source.Microphone) ?? null,
        identity: person.identity,
        name: person.name || person.identity,
        isLocal: person === room.localParticipant,
        speaking: person.isSpeaking,
        micOn: person.isMicrophoneEnabled,
        camOn: person.isCameraEnabled,
        quality: qualityOf(person),
        hand: hands[person.identity] ?? false,
        reaction: reactions[person.identity] ?? null,
        guest: isGuest(person),
      }
      if (screen?.track) {
        result.push({
          ...base,
          key: `${person.identity}:screen`,
          isScreen: true,
          publication: screen,
        })
      }
      result.push({
        ...base,
        key: `${person.identity}:camera`,
        isScreen: false,
        publication: camera,
      })
    }
    // Демонстрация экрана — первой: её смотрят
    return result.sort((a, b) => Number(b.isScreen) - Number(a.isScreen))
  }, [hands, reactions, version, state])

  const selectDevice = useCallback((kind: MediaDeviceKind, deviceId: string) => {
    const room = roomRef.current
    if (!room) return
    void room
      .switchActiveDevice(kind, deviceId)
      .then(() => setActiveDevices((current) => ({ ...current, [kind]: deviceId })))
      .catch(() => undefined)
  }, [])

  const reconnect = useCallback(() => {
    if (!refreshToken) return
    setState('connecting')
    void refreshToken()
      .then((next) => setToken(next))
      .catch((cause: unknown) => {
        setState('error')
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [refreshToken])

  return {
    state,
    error,
    tiles,
    localIdentity,
    micOn: local?.isMicrophoneEnabled ?? false,
    camOn: local?.isCameraEnabled ?? false,
    sharing: local?.isScreenShareEnabled ?? false,
    handRaised,
    recording: roomRef.current?.isRecording ?? false,
    devices,
    activeDevices,
    toggleMic: () => {
      const participant = roomRef.current?.localParticipant
      if (!participant) return
      void participant
        .setMicrophoneEnabled(!participant.isMicrophoneEnabled)
        .then(refresh)
        .catch(() => undefined)
    },
    toggleCam: () => {
      const participant = roomRef.current?.localParticipant
      if (!participant) return
      void participant
        .setCameraEnabled(!participant.isCameraEnabled)
        .then(refresh)
        .catch(() => undefined)
    },
    toggleShare: () => {
      const participant = roomRef.current?.localParticipant
      if (!participant) return
      void participant
        .setScreenShareEnabled(!participant.isScreenShareEnabled)
        .then(refresh)
        .catch(() => undefined)
    },
    toggleHand: () => {
      const raised = !handRaised
      setHands((current) => ({ ...current, [localIdentity]: raised }))
      publish({ type: 'hand', raised })
    },
    sendReaction: (emoji: string) => {
      setReactions((current) => ({ ...current, [localIdentity]: emoji }))
      window.setTimeout(
        () =>
          setReactions((current) => {
            const { [localIdentity]: _gone, ...rest } = current
            return rest
          }),
        REACTION_MS,
      )
      publish({ type: 'reaction', emoji })
    },
    showToAll: (object) => publish({ type: 'show', ...object }),
    selectDevice,
    reconnect,
    disconnect: () => {
      void roomRef.current?.disconnect()
      setState('disconnected')
    },
  }
}
