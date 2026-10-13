import { Button, type ControlProps, IconButton, Skeleton, useToast } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Camera, ImageOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '~/shared/i18n.js'
import { compressPhoto, PhotoFormatError, saveLocalPhoto } from '~/shared/offline/photos.js'
import { formPhotoQuery } from './queries.js'

/**
 * Поле «Фото» сводки (ADR-0208): снимок с камеры или из галереи телефона. Фото
 * сжимается сразу и ложится на устройство; значение поля — ключ снимка, пока он не
 * ушёл на сервер (при сохранении или сдаче, без сети — из очереди), и файл после.
 */
export function PhotoField({
  id,
  field,
  value,
  onChange,
  invalid,
  disabled,
  userId,
}: ControlProps & { userId: string }) {
  const t = useT()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const current = typeof value === 'string' && value.length > 0 ? value : null

  const take = async (file: File) => {
    setBusy(true)
    try {
      const blob = await compressPhoto(file)
      const photo = await saveLocalPhoto({ userId, fieldKey: field.key, blob })
      onChange(photo.id)
    } catch (error) {
      toast.error(
        error instanceof PhotoFormatError && error.message === 'size'
          ? t('forms.photo.size')
          : t('forms.photo.format'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {current ? <PhotoThumb value={current} userId={userId} /> : null}
      <div className="flex items-center gap-1">
        <Button
          id={id}
          type="button"
          size="sm"
          variant="secondary"
          icon={<Camera className="size-3.5" />}
          loading={busy}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onClick={() => input.current?.click()}
        >
          {current ? t('forms.photo.replace') : t('forms.photo.add')}
        </Button>
        {current && !disabled ? (
          <IconButton
            type="button"
            size="sm"
            label={t('forms.photo.remove')}
            onClick={() => onChange(null)}
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {/* Без `capture`: телефон предлагает и камеру, и галерею */}
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={t('forms.photo.add')}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void take(file)
        }}
      />
    </div>
  )
}

/**
 * Миниатюра снимка: ещё не отправленный — с устройства, отправленный — файлом
 * сервера по подписанной ссылке (её даёт право на файл: вложение формы, ADR-0208).
 */
export function PhotoThumb({
  value,
  userId,
  size = 'md',
}: {
  value: string
  userId: string | null
  size?: 'sm' | 'md'
}) {
  const t = useT()
  const source = useQuery(formPhotoQuery(value, userId))
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blob = source.data?.kind === 'local' ? source.data.blob : null
  useEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setBlobUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setBlobUrl(null)
    }
  }, [blob])

  const box = size === 'sm' ? 'h-12 w-16' : 'h-32 w-44'
  if (source.isLoading) return <Skeleton className={box} />
  const src = source.data?.kind === 'remote' ? source.data.url : blobUrl
  if (!src) {
    return (
      <span
        className={`flex ${box} items-center justify-center rounded-sm border border-line bg-surface-2 text-fg-muted`}
        title={t('forms.photo.unavailable')}
      >
        <ImageOff className="size-4" aria-label={t('forms.photo.unavailable')} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={t('forms.photo.alt')}
      className={`${box} rounded-sm border border-line bg-surface-2 object-cover`}
    />
  )
}
