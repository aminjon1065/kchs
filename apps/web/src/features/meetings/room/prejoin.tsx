import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  ProgressBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kchs/ui'
import { VideoOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'

/** Выбор перед входом: устройства и с чем войти (ADR-0162). */
export interface DevicePrefs {
  audioDeviceId: string | null
  videoDeviceId: string | null
  mic: boolean
  camera: boolean
}

const STORAGE_KEY = 'kchs.meetings.devices'
/** Значение «устройство по умолчанию» — у Select не бывает пустого значения. */
const DEFAULT_DEVICE = '__default'

/** Выбор прошлого входа — удобство смотрящего, без него всё работает. */
export function loadDevicePrefs(camera: boolean): DevicePrefs {
  const fallback: DevicePrefs = { audioDeviceId: null, videoDeviceId: null, mic: true, camera }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<DevicePrefs>
    if (!saved || typeof saved !== 'object') return fallback
    return {
      audioDeviceId: typeof saved.audioDeviceId === 'string' ? saved.audioDeviceId : null,
      videoDeviceId: typeof saved.videoDeviceId === 'string' ? saved.videoDeviceId : null,
      mic: saved.mic !== false,
      camera: typeof saved.camera === 'boolean' ? saved.camera : camera,
    }
  } catch {
    return fallback
  }
}

function saveDevicePrefs(prefs: DevicePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // хранилище недоступно — выбор просто не запомнится
  }
}

function stop(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

/**
 * Проверка перед входом в комнату (ADR-0162): предпросмотр камеры, уровень
 * микрофона, выбор устройств и «войти с камерой/микрофоном». Всё — в браузере,
 * медиасервер для этого не нужен; выбор запоминается для следующего входа.
 */
export function PrejoinDialog({
  title,
  initial,
  loading,
  onJoin,
  onClose,
}: {
  title: string
  initial: DevicePrefs
  loading?: boolean
  onJoin: (prefs: DevicePrefs) => void
  onClose: () => void
}) {
  const t = useT()
  const [prefs, setPrefs] = useState<DevicePrefs>(initial)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [denied, setDenied] = useState(false)
  const [level, setLevel] = useState(0)
  const video = useRef<HTMLVideoElement>(null)

  // Поток предпросмотра: камера — картинка, микрофон — полоска уровня.
  // После разрешения браузер отдаёт и названия устройств
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setDenied(true)
      return
    }
    let alive = true
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let frame = 0
    const wantVideo = prefs.camera
    const wantAudio = prefs.mic
    if (!wantVideo && !wantAudio) {
      setLevel(0)
      return
    }
    void navigator.mediaDevices
      .getUserMedia({
        video: wantVideo
          ? prefs.videoDeviceId
            ? { deviceId: { exact: prefs.videoDeviceId } }
            : true
          : false,
        audio: wantAudio
          ? prefs.audioDeviceId
            ? { deviceId: { exact: prefs.audioDeviceId } }
            : true
          : false,
      })
      .then(async (media) => {
        if (!alive) {
          stop(media)
          return
        }
        stream = media
        setDenied(false)
        if (video.current) video.current.srcObject = wantVideo ? media : null
        setDevices(await navigator.mediaDevices.enumerateDevices())
        if (wantAudio && media.getAudioTracks().length > 0 && typeof AudioContext !== 'undefined') {
          context = new AudioContext()
          const analyser = context.createAnalyser()
          analyser.fftSize = 256
          context.createMediaStreamSource(media).connect(analyser)
          const samples = new Uint8Array(analyser.frequencyBinCount)
          const tick = () => {
            analyser.getByteFrequencyData(samples)
            const peak = samples.reduce((max, value) => Math.max(max, value), 0)
            setLevel(Math.round((peak / 255) * 100))
            frame = requestAnimationFrame(tick)
          }
          tick()
        }
      })
      .catch(() => {
        if (alive) setDenied(true)
      })
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      void context?.close()
      stop(stream)
    }
  }, [prefs.camera, prefs.mic, prefs.videoDeviceId, prefs.audioDeviceId])

  const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId)
  const microphones = devices.filter((device) => device.kind === 'audioinput' && device.deviceId)

  const join = () => {
    saveDevicePrefs(prefs)
    onJoin(prefs)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('meetings.prejoin.title')}
        description={title}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={loading} onClick={join} data-testid="prejoin-join">
              {t('meetings.actions.join')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-surface-3">
            <video
              ref={video}
              autoPlay
              muted
              playsInline
              aria-label={t('meetings.prejoin.preview')}
              className={prefs.camera && !denied ? 'size-full object-cover' : 'hidden'}
            />
            {prefs.camera && !denied ? null : (
              <span className="flex flex-col items-center gap-1 text-sm text-fg-muted">
                <VideoOff className="size-6" aria-hidden />
                {t('meetings.prejoin.cameraOff')}
              </span>
            )}
          </div>

          {denied ? (
            <Callout tone="warning" title={t('meetings.prejoin.noAccess')}>
              {t('meetings.prejoin.noAccessHint')}
            </Callout>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Switch
                checked={prefs.camera}
                onCheckedChange={(camera) => setPrefs((current) => ({ ...current, camera }))}
                label={t('meetings.prejoin.cameraOn')}
              />
              <Field label={t('meetings.prejoin.camera')}>
                <Select
                  value={prefs.videoDeviceId ?? DEFAULT_DEVICE}
                  onValueChange={(value) =>
                    setPrefs((current) => ({
                      ...current,
                      videoDeviceId: value === DEFAULT_DEVICE ? null : value,
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('meetings.prejoin.camera')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_DEVICE}>
                      {t('meetings.prejoin.defaultDevice')}
                    </SelectItem>
                    {cameras.map((device, index) => (
                      <SelectItem key={device.deviceId} value={device.deviceId}>
                        {device.label || t('meetings.prejoin.cameraN', { n: index + 1 })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="flex flex-col gap-2">
              <Switch
                checked={prefs.mic}
                onCheckedChange={(mic) => setPrefs((current) => ({ ...current, mic }))}
                label={t('meetings.prejoin.micOn')}
              />
              <Field label={t('meetings.prejoin.microphone')}>
                <Select
                  value={prefs.audioDeviceId ?? DEFAULT_DEVICE}
                  onValueChange={(value) =>
                    setPrefs((current) => ({
                      ...current,
                      audioDeviceId: value === DEFAULT_DEVICE ? null : value,
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('meetings.prejoin.microphone')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_DEVICE}>
                      {t('meetings.prejoin.defaultDevice')}
                    </SelectItem>
                    {microphones.map((device, index) => (
                      <SelectItem key={device.deviceId} value={device.deviceId}>
                        {device.label || t('meetings.prejoin.microphoneN', { n: index + 1 })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <ProgressBar
                value={prefs.mic ? level : 0}
                max={100}
                label={t('meetings.prejoin.level')}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
