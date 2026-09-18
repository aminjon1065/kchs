import type { ActiveDelegation, PrincipalRef } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  Field,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { delegationsQuery, keys, meQuery, principalsQuery } from '~/shared/api/queries.js'

const SCOPES = ['all', 'approvals', 'instructions', 'documents', 'meetings'] as const
type Scope = (typeof SCOPES)[number]

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/**
 * Замещение (P0-E04 S03, 03-access-model.md §Делегирование): назначить
 * заместителя на период и область, завершить досрочно. Заместитель видит
 * баннер «Вы замещаете» и действует «от имени» — с двойной записью в аудите.
 */
export function DelegationCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const { data: delegations = [] } = useQuery(delegationsQuery())
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.delegations })
    void client.invalidateQueries({ queryKey: keys.me })
  }

  const stop = useMutation({
    mutationFn: (id: string) => http.delete(`/me/delegations/${id}`),
    onSuccess: () => {
      toast.show({ title: t('admin.delegation.stopped'), tone: 'info' })
      refresh()
    },
    onError: () => toast.error(t('errors.forbidden')),
  })

  const period = (item: ActiveDelegation) =>
    `${formatDate(item.startsAt, { locale })} — ${formatDate(item.endsAt, { locale })}`

  return (
    <Card
      title={t('admin.delegation.title')}
      padded={false}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon={<UserCheck className="size-3.5" />}
          onClick={() => setCreating(true)}
        >
          {t('admin.delegation.create')}
        </Button>
      }
    >
      {delegations.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-muted">{t('admin.delegation.none')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {delegations.map((item) => {
            const mine = item.fromUser.id === me?.user.id
            return (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Avatar
                  name={mine ? item.toUser.displayName : item.fromUser.displayName}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {item.fromUser.displayName} → {item.toUser.displayName}
                  </span>
                  <span className="block text-xs text-fg-muted">
                    {t(`admin.delegation.scopes.${item.scope}`)} · {period(item)}
                  </span>
                </span>
                <Badge tone="warning" size="sm">
                  {t('admin.delegation.active')}
                </Badge>
                {mine ? (
                  <Button variant="ghost" size="sm" onClick={() => stop.mutate(item.id)}>
                    {t('admin.delegation.stop')}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <CreateDelegationDialog
        open={creating}
        onOpenChange={setCreating}
        excludeUserId={me?.user.id}
        onCreated={(name) => {
          toast.show({ title: t('admin.delegation.created', { name }), tone: 'success' })
          refresh()
        }}
      />
    </Card>
  )
}

function CreateDelegationDialog({
  open,
  onOpenChange,
  excludeUserId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  excludeUserId?: string
  onCreated: (name: string) => void
}) {
  const t = useT()
  const formId = useId()
  const empty = () => ({
    search: '',
    deputy: null as PrincipalRef | null,
    scope: 'all' as Scope,
    from: isoDay(new Date()),
    to: isoDay(new Date(Date.now() + 7 * 86_400_000)),
    note: '',
  })
  const [form, setForm] = useState(empty)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<ReturnType<typeof empty>>) =>
    setForm((current) => ({ ...current, ...patch }))
  const query = useDebouncedValue(form.search, 200)
  const { data: candidates = [] } = useQuery(principalsQuery(query, 'user'))

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setForm(empty())
      setError(null)
    }
  }

  const create = useMutation({
    mutationFn: () =>
      http.post('/me/delegations', {
        toUserId: form.deputy?.id,
        scope: form.scope,
        // Период — с начала первого дня до конца последнего, в поясе браузера
        startsAt: new Date(`${form.from}T00:00:00`).toISOString(),
        endsAt: new Date(`${form.to}T23:59:59`).toISOString(),
        note: form.note.trim() || null,
      }),
    onSuccess: () => {
      onCreated(form.deputy?.title ?? '')
      close(false)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const valid = Boolean(form.deputy) && form.from <= form.to

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={t('admin.delegation.create')}
        size="sm"
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
              {t('admin.delegation.assign')}
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
          {form.deputy ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2">
              <Avatar name={form.deputy.title} src={form.deputy.avatarUrl} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{form.deputy.title}</span>
              <Button variant="ghost" size="sm" onClick={() => set({ deputy: null })}>
                {t('common.actions.edit')}
              </Button>
            </div>
          ) : (
            <Field label={t('admin.delegation.to')}>
              <SearchInput
                value={form.search}
                onValueChange={(search) => set({ search })}
                placeholder={t('spaces.members.searchPlaceholder')}
                autoFocus
              />
              {query && candidates.length > 0 ? (
                <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-line bg-surface p-1">
                  {candidates
                    .filter((candidate) => candidate.id !== excludeUserId)
                    .map((candidate) => (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          onClick={() => set({ deputy: candidate })}
                          className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3"
                        >
                          <Avatar name={candidate.title} src={candidate.avatarUrl} size="sm" />
                          <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              ) : null}
            </Field>
          )}
          <Field label={t('admin.delegation.scope')}>
            <Select value={form.scope} onValueChange={(next) => set({ scope: next as Scope })}>
              <SelectTrigger aria-label={t('admin.delegation.scope')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPES.map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {t(`admin.delegation.scopes.${scope}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('admin.delegation.from')} htmlFor={`${formId}-from`}>
              <Input
                id={`${formId}-from`}
                type="date"
                value={form.from}
                onChange={(event) => set({ from: event.target.value })}
              />
            </Field>
            <Field label={t('admin.delegation.until')} htmlFor={`${formId}-to`}>
              <Input
                id={`${formId}-to`}
                type="date"
                min={form.from}
                value={form.to}
                onChange={(event) => set({ to: event.target.value })}
              />
            </Field>
          </div>
          <Field label={t('admin.delegation.note')} htmlFor={`${formId}-note`}>
            <Textarea
              id={`${formId}-note`}
              maxLength={500}
              value={form.note}
              onChange={(event) => set({ note: event.target.value })}
            />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  )
}
