import {
  type AdminAnnouncement,
  ANNOUNCEMENT_SEVERITIES,
  type AnnouncementSeverity,
  type AnnouncementStatus,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  SegmentedControl,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { adminAnnouncementsQuery, keys } from '~/shared/api/queries.js'

const STATUS_TONES: Record<AnnouncementStatus, 'accent' | 'success' | 'neutral'> = {
  scheduled: 'accent',
  active: 'success',
  ended: 'neutral',
}

export const SEVERITY_TONES: Record<AnnouncementSeverity, 'neutral' | 'warning' | 'danger'> = {
  info: 'neutral',
  warning: 'warning',
  critical: 'danger',
}

/**
 * «Объявления» (15-admin-operations.md «Система»): публикация с периодом
 * показа и снятие. Сотрудники видят их в «Мой день».
 */
export function AnnouncementsSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { data: items = [], isLoading } = useQuery(adminAnnouncementsQuery())
  const [creating, setCreating] = useState(false)
  const [withdrawing, setWithdrawing] = useState<AdminAnnouncement | null>(null)

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.adminAnnouncements })
    void client.invalidateQueries({ queryKey: keys.announcements })
  }

  const withdraw = useMutation({
    mutationFn: (id: string) => http.post(`/admin/announcements/${id}/withdraw`),
    onSuccess: () => {
      toast.show({ title: t('admin.announcements.withdrawn'), tone: 'info' })
      setWithdrawing(null)
      refresh()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const period = (item: AdminAnnouncement) =>
    item.endsAt
      ? t('admin.announcements.period', {
          from: formatDateTime(item.startsAt, { locale }),
          to: formatDateTime(item.endsAt, { locale }),
        })
      : t('admin.announcements.since', { from: formatDateTime(item.startsAt, { locale }) })

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-secondary">{t('admin.announcements.hint')}</p>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => setCreating(true)}
        >
          {t('admin.announcements.create')}
        </Button>
      </div>
      <Card padded={false}>
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={<Megaphone />} title={t('admin.announcements.empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{item.title}</span>
                    <Badge tone={SEVERITY_TONES[item.severity]} size="sm">
                      {t(`admin.announcements.severities.${item.severity}`)}
                    </Badge>
                    <Badge tone={STATUS_TONES[item.status]} size="sm" dot>
                      {t(`admin.announcements.statuses.${item.status}`)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm whitespace-pre-line text-fg-secondary">{item.body}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {period(item)}
                    {item.createdBy ? ` · ${item.createdBy.displayName}` : ''}
                  </p>
                </div>
                {item.status !== 'ended' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('admin.announcements.withdrawOf', { title: item.title })}
                    onClick={() => setWithdrawing(item)}
                  >
                    {t('admin.announcements.withdraw')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CreateAnnouncementDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          toast.show({ title: t('admin.announcements.published'), tone: 'success' })
          refresh()
        }}
      />
      <AlertDialog
        open={withdrawing !== null}
        onOpenChange={(next) => (next ? undefined : setWithdrawing(null))}
        title={t('admin.announcements.withdrawTitle', { title: withdrawing?.title ?? '' })}
        description={t('admin.announcements.withdrawHint')}
        confirmLabel={t('admin.announcements.withdraw')}
        loading={withdraw.isPending}
        onConfirm={() => {
          if (withdrawing) withdraw.mutate(withdrawing.id)
        }}
      />
    </div>
  )
}

/** Локальное время из поля `datetime-local` → ISO; пусто — null. */
const toIso = (value: string) => (value ? new Date(value).toISOString() : null)

function CreateAnnouncementDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const t = useT()
  const formId = useId()
  const empty = () => ({
    title: '',
    body: '',
    severity: 'info' as AnnouncementSeverity,
    startsAt: '',
    endsAt: '',
  })
  const [form, setForm] = useState(empty)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<ReturnType<typeof empty>>) =>
    setForm((current) => ({ ...current, ...patch }))

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setForm(empty())
      setError(null)
    }
  }

  const create = useMutation({
    mutationFn: () =>
      http.post('/admin/announcements', {
        title: form.title.trim(),
        body: form.body.trim(),
        severity: form.severity,
        startsAt: toIso(form.startsAt),
        endsAt: toIso(form.endsAt),
      }),
    onSuccess: () => {
      onCreated()
      close(false)
    },
    onError: (err) => {
      const fieldErrors = err instanceof ApiError ? Object.values(err.fieldErrors()) : []
      setError(fieldErrors[0] ?? (err instanceof ApiError ? err.message : t('errors.unknown')))
    },
  })

  const valid = form.title.trim().length > 0 && form.body.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={t('admin.announcements.create')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!valid}
              loading={create.isPending}
            >
              {t('admin.announcements.publish')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) create.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.announcements.fields.title')} htmlFor={`${formId}-title`} required>
            <Input
              id={`${formId}-title`}
              maxLength={200}
              value={form.title}
              onChange={(event) => set({ title: event.target.value })}
              autoFocus
            />
          </Field>
          <Field label={t('admin.announcements.fields.body')} htmlFor={`${formId}-body`} required>
            <Textarea
              id={`${formId}-body`}
              maxLength={4000}
              value={form.body}
              onChange={(event) => set({ body: event.target.value })}
            />
          </Field>
          <Field label={t('admin.announcements.fields.severity')}>
            <SegmentedControl
              aria-label={t('admin.announcements.fields.severity')}
              value={form.severity}
              onValueChange={(severity) => set({ severity })}
              options={ANNOUNCEMENT_SEVERITIES.map((severity) => ({
                value: severity,
                label: t(`admin.announcements.severities.${severity}`),
              }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('admin.announcements.fields.startsAt')}
              hint={t('admin.announcements.fields.startsAtHint')}
              htmlFor={`${formId}-starts`}
            >
              <Input
                id={`${formId}-starts`}
                type="datetime-local"
                value={form.startsAt}
                onChange={(event) => set({ startsAt: event.target.value })}
              />
            </Field>
            <Field
              label={t('admin.announcements.fields.endsAt')}
              hint={t('admin.announcements.fields.endsAtHint')}
              htmlFor={`${formId}-ends`}
            >
              <Input
                id={`${formId}-ends`}
                type="datetime-local"
                min={form.startsAt || undefined}
                value={form.endsAt}
                onChange={(event) => set({ endsAt: event.target.value })}
              />
            </Field>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
