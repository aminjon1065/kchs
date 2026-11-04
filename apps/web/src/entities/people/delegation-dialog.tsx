import type { PrincipalRef } from '@kchs/contracts'
import {
  Avatar,
  Button,
  Callout,
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
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { ApiError } from '~/shared/api/errors.js'
import { principalsQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'

const SCOPES = ['all', 'approvals', 'instructions', 'documents', 'meetings'] as const
type Scope = (typeof SCOPES)[number]

/** Тело назначения замещения — одно у профиля и у консоли. */
export interface DelegationBody {
  toUserId: string
  scope: Scope
  startsAt: string
  endsAt: string
  note: string | null
}

/**
 * День в поясе браузера (`yyyy-mm-dd`): `toISOString` дал бы день по UTC, и с полуночи до
 * пяти утра по Душанбе подставлялось бы вчера.
 */
const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/**
 * Назначение заместителя (03-access-model.md §Делегирование): сотрудник, область и
 * период. Отправку задаёт экран: своё замещение из профиля (`/me/delegations`) или
 * замещение за сотрудника из консоли (`/users/:id/delegations`, ADR-0229).
 */
export function CreateDelegationDialog({
  open,
  onOpenChange,
  excludeUserId,
  submit,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  excludeUserId?: string | undefined
  submit: (body: DelegationBody) => Promise<unknown>
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
      submit({
        toUserId: form.deputy!.id,
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
