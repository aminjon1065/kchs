import type { MeetingGuestJoin, MeetingJoin } from '@kchs/contracts'
import { Button, Callout, Card, Field, Input, Spinner } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { guestJoin, guestPreview, meetingKeys } from './queries.js'
import { MeetingRoom } from './room/meeting-room.js'

/** Как часто гость спрашивает, впустили ли его. */
const POLL_MS = 3000

/**
 * Вход гостя по ссылке `/meet/<токен>` (ADR-0091): без входа в систему и без
 * доступа к объектам. Имя гость называет сам, в комнату его впускает ведущий —
 * до тех пор экран ожидания.
 */
export function GuestMeetingScreen({ token }: { token: string }) {
  const t = useT()
  const [name, setName] = useState('')
  const [result, setResult] = useState<MeetingGuestJoin | null>(null)
  const [left, setLeft] = useState(false)

  const preview = useQuery({
    queryKey: meetingKeys.guest(token),
    queryFn: () => guestPreview(token),
    retry: false,
  })

  const ask = useMutation({
    mutationFn: (input: { name: string; requestId?: string }) => guestJoin(token, input),
    onSuccess: (next) => setResult(next),
  })

  const askMutate = ask.mutate
  const requestId = result?.requestId
  const waiting = result?.state === 'waiting'

  // Ожидание решения: опрос вместо сокета — у гостя нет сессии, а значит и
  // подключения к шлюзу realtime
  useEffect(() => {
    if (!waiting || !requestId) return
    const timer = window.setInterval(() => askMutate({ name: name.trim(), requestId }), POLL_MS)
    return () => window.clearInterval(timer)
  }, [waiting, requestId, name, askMutate])

  const refreshToken = useCallback(async (): Promise<MeetingJoin> => {
    const next = await guestJoin(token, { name: name.trim(), ...(requestId ? { requestId } : {}) })
    if (!next.join) throw new Error(t('meetings.guest.notAdmitted'))
    return next.join
  }, [name, requestId, t, token])

  if (preview.isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (preview.isError || !preview.data) {
    return (
      <Centered>
        <Callout tone="danger" title={t('meetings.guest.invalid')}>
          {t('meetings.guest.invalidHint')}
        </Callout>
      </Centered>
    )
  }

  const meeting = preview.data

  if (result?.state === 'admitted' && result.join && !left) {
    return (
      <MeetingRoom
        title={meeting.title}
        meeting={null}
        join={result.join}
        refreshToken={refreshToken}
        onLeave={() => setLeft(true)}
      />
    )
  }

  return (
    <Centered>
      <Card className="flex w-full max-w-96 flex-col gap-3 p-5">
        <h1 className="text-base font-semibold">{meeting.title}</h1>
        {meeting.status === 'ended' || meeting.status === 'cancelled' ? (
          <Callout tone="neutral">{t('meetings.guest.finished')}</Callout>
        ) : !meeting.enabled ? (
          <Callout tone="warning">{t('meetings.errors.unavailable')}</Callout>
        ) : left ? (
          <Callout tone="neutral">{t('meetings.guest.left')}</Callout>
        ) : result?.state === 'denied' ? (
          <Callout tone="danger">{t('meetings.guest.denied')}</Callout>
        ) : waiting ? (
          <div className="flex items-center gap-2 text-sm text-fg-secondary">
            <Spinner className="size-4" />
            {t('meetings.guest.waiting')}
          </div>
        ) : (
          <>
            <Field label={t('meetings.guest.name')} htmlFor="guest-name">
              <Input
                id="guest-name"
                value={name}
                data-testid="guest-name"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('meetings.guest.namePlaceholder')}
              />
            </Field>
            <Button
              variant="primary"
              disabled={name.trim().length < 2}
              loading={ask.isPending}
              data-testid="guest-knock"
              onClick={() => askMutate({ name: name.trim() })}
            >
              {t('meetings.guest.knock')}
            </Button>
            <p className="text-xs text-fg-muted">{t('meetings.guest.note')}</p>
          </>
        )}
      </Card>
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-96">{children}</div>
    </div>
  )
}
