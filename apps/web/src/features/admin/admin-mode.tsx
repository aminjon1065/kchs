import { ADMIN_MODE_MINUTES, type AdminModeState } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'

const DURATIONS = [15, ADMIN_MODE_MINUTES.default, 60, ADMIN_MODE_MINUTES.max]

/** Режим администратора сессии, если он ещё действует. */
function useAdminMode(): AdminModeState | null {
  const { data: me } = useQuery(meQuery())
  const client = useQueryClient()
  const state = me?.adminMode ?? null
  const left = state ? new Date(state.until).getTime() - Date.now() : 0

  // Срок вышел — перечитываем профиль: сервер уже не пускает к грифам выше допуска
  useEffect(() => {
    if (!state || left <= 0) return
    const timer = setTimeout(() => void client.invalidateQueries(), left + 500)
    return () => clearTimeout(timer)
  }, [state, left, client])

  return state && left > 0 ? state : null
}

/** Доступ сменился — перечитать всё: списки, карточки, поиск. */
function useExitAdminMode() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => http.delete('/me/admin-mode'),
    onSuccess: () => {
      toast.show({ title: t('access.adminMode.exited'), tone: 'info' })
      void client.invalidateQueries()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })
}

/**
 * Полоса «Режим администратора до …» (ADR-0080): режим включается явно, виден
 * всё время и выключается одной кнопкой; каждое действие в нём — в аудите.
 */
export function AdminModeBanner() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const state = useAdminMode()
  const exit = useExitAdminMode()
  if (!state) return null
  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-danger/40 bg-danger-subtle px-3 text-xs text-fg"
    >
      <ShieldAlert className="size-3.5 shrink-0 text-danger" aria-hidden />
      <span className="shrink-0 font-medium">
        {t('access.adminMode.active', {
          time: formatDateTime(state.until, { locale }),
        })}
      </span>
      <span className="min-w-0 truncate text-fg-secondary" title={state.reason}>
        {t('access.adminMode.activeReason', { reason: state.reason })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        loading={exit.isPending}
        onClick={() => exit.mutate()}
      >
        {t('access.adminMode.exit')}
      </Button>
    </div>
  )
}

/** Карточка раздела «Безопасность»: вход в режим администратора с обоснованием. */
export function AdminModeCard() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const state = useAdminMode()
  const exit = useExitAdminMode()
  const [open, setOpen] = useState(false)
  return (
    <Card title={t('access.adminMode.enter')}>
      <p className="text-xs text-fg-secondary">{t('access.adminMode.description')}</p>
      <div className="mt-3 flex items-center gap-2">
        {state ? (
          <>
            <span className="text-xs text-fg">
              {t('access.adminMode.active', { time: formatDateTime(state.until, { locale }) })}
            </span>
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              loading={exit.isPending}
              onClick={() => exit.mutate()}
            >
              {t('access.adminMode.exit')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon={<ShieldAlert className="size-3.5" />}
            onClick={() => setOpen(true)}
          >
            {t('access.adminMode.title')}
          </Button>
        )}
      </div>
      {open ? <EnterAdminModeDialog onClose={() => setOpen(false)} /> : null}
    </Card>
  )
}

function EnterAdminModeDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const [minutes, setMinutes] = useState(String(ADMIN_MODE_MINUTES.default))
  const [failure, setFailure] = useState<string | null>(null)
  const enter = useMutation({
    mutationFn: () =>
      http.post<AdminModeState>('/me/admin-mode', {
        reason: reason.trim(),
        minutes: Number(minutes),
      }),
    onSuccess: () => {
      toast.show({ title: t('access.adminMode.entered'), tone: 'warning' })
      void client.invalidateQueries()
      onClose()
    },
    onError: (err) => setFailure(err instanceof ApiError ? err.message : t('errors.unknown')),
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('access.adminMode.title')}
        description={t('access.adminMode.description')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 10}
              loading={enter.isPending}
              onClick={() => enter.mutate()}
            >
              {t('access.adminMode.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field
            label={t('access.adminMode.reason')}
            htmlFor={reasonId}
            hint={t('access.adminMode.reasonHint')}
            required
          >
            <Textarea
              id={reasonId}
              autoFocus
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Field label={t('access.adminMode.minutes')}>
            <Select value={minutes} onValueChange={setMinutes}>
              <SelectTrigger aria-label={t('access.adminMode.minutes')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {t('access.adminMode.minutesValue', { count: value })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
