import type { Level, PrincipalRef } from '@kchs/contracts'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  Field,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Switch,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, Lock, ShieldQuestion, Unlink, X } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { keys, objectAccessQuery, principalsQuery } from '~/shared/api/queries.js'

const LEVELS: Level[] = ['view', 'comment', 'edit', 'manage']

/**
 * Единый диалог «Поделиться» для любого объекта
 * (03-ui/04-interaction-patterns.md §6, 03-access-model.md).
 */
export function ShareDialog({
  objectId,
  title,
  open,
  onOpenChange,
}: {
  objectId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()

  const [search, setSearch] = useState('')
  const [level, setLevel] = useState<Level>('view')
  const [pending, setPending] = useState<PrincipalRef[]>([])
  const [explainFor, setExplainFor] = useState<string | null>(null)

  const query = useDebouncedValue(search, 200)
  const { data: access, isLoading } = useQuery(objectAccessQuery(objectId))
  const { data: candidates = [] } = useQuery(principalsQuery(query))

  const grant = useMutation({
    mutationFn: () =>
      http.post(`/objects/${objectId}/access`, {
        grants: pending.map((principal) => ({
          principal: { type: principal.type, id: principal.id },
          level,
        })),
      }),
    onSuccess: () => {
      setPending([])
      setSearch('')
      toast.show({ title: t('access.share.invited'), tone: 'success' })
      void client.invalidateQueries({ queryKey: keys.objectAccess(objectId) })
    },
    onError: () => toast.error(t('errors.forbidden')),
  })

  const revoke = useMutation({
    mutationFn: (principal: { type: string; id: string }) =>
      http.delete(`/objects/${objectId}/access`, { principal }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.objectAccess(objectId) }),
  })

  const setMode = useMutation({
    mutationFn: (mode: 'inherit' | 'restricted') =>
      http.put(`/objects/${objectId}/access-mode`, { mode }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.objectAccess(objectId) })
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
    },
  })

  const copyLink = async (): Promise<void> => {
    await navigator.clipboard.writeText(`${window.location.origin}/o/${objectId}`)
    toast.show({ title: 'Ссылка скопирована', tone: 'success' })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('access.share.title', { title })}
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              icon={<Copy className="size-4" />}
              onClick={() => void copyLink()}
            >
              {t('common.actions.copyLink')}
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.actions.close')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('access.share.addPeople')}>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <SearchInput
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Имя, группа или подразделение"
                />
                {query && candidates.length > 0 ? (
                  <ul className="absolute inset-x-0 top-full z-(--z-dropdown) mt-1 max-h-56 overflow-y-auto rounded-md border border-line bg-overlay p-1 shadow-md">
                    {candidates.map((principal) => (
                      <li key={`${principal.type}:${principal.id}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setPending((current) =>
                              current.some(
                                (p) => p.id === principal.id && p.type === principal.type,
                              )
                                ? current
                                : [...current, principal],
                            )
                            setSearch('')
                          }}
                          className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3"
                        >
                          <Avatar name={principal.title} src={principal.avatarUrl} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{principal.title}</span>
                            {principal.subtitle ? (
                              <span className="block truncate text-xs text-fg-muted">
                                {principal.subtitle}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <Select value={level} onValueChange={(next) => setLevel(next as Level)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`access.levels.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>

          {pending.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {pending.map((principal) => (
                <span
                  key={`${principal.type}:${principal.id}`}
                  className="inline-flex h-6 items-center gap-1.5 rounded-xs border border-line bg-surface-2 px-1.5 text-xs"
                >
                  <Avatar name={principal.title} src={principal.avatarUrl} size="xs" />
                  {principal.title}
                  <button
                    type="button"
                    aria-label="Убрать"
                    onClick={() =>
                      setPending((current) =>
                        current.filter(
                          (p) => !(p.id === principal.id && p.type === principal.type),
                        ),
                      )
                    }
                    className="text-fg-muted hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <Button
                size="sm"
                variant="primary"
                loading={grant.isPending}
                onClick={() => grant.mutate()}
              >
                {t('common.actions.add')}
              </Button>
            </div>
          ) : null}

          <Separator />

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                {t('access.share.current')}
              </h3>
              {access ? (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-secondary">
                  <Switch
                    checked={access.accessMode === 'inherit'}
                    disabled={!access.canManage}
                    onCheckedChange={(checked) =>
                      setMode.mutate(checked ? 'inherit' : 'restricted')
                    }
                  />
                  {t('access.share.inheritance')}
                </label>
              ) : null}
            </div>

            {access?.accessMode === 'restricted' ? (
              <Callout tone="warning" className="mb-2">
                {t('access.share.breakWarning')}
              </Callout>
            ) : null}

            {isLoading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-9 w-full" />
                ))}
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {access?.entries.map((entry) => {
                  const key = `${entry.principal.type}:${entry.principal.id}`
                  const inherited = entry.reasons.some((r) => r.kind !== 'explicit')
                  return (
                    <li key={key} className="flex items-center gap-2 px-2.5 py-2">
                      <Avatar
                        name={entry.principal.title}
                        src={entry.principal.avatarUrl}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">
                          {entry.principal.title}
                        </span>
                        <span className="block truncate text-xs text-fg-muted">
                          {entry.reasons
                            .slice(0, 1)
                            .map((reason) =>
                              t(reason.messageKey, reason.params as Record<string, string>),
                            )
                            .join(', ')}
                        </span>
                      </span>
                      <Badge tone={inherited ? 'neutral' : 'accent'} size="sm">
                        {t(`access.levels.${entry.level}`)}
                      </Badge>
                      <Popover
                        open={explainFor === key}
                        onOpenChange={(next) => setExplainFor(next ? key : null)}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            aria-label={t('access.explain.title')}
                            className="rounded-xs p-1 text-fg-muted hover:bg-surface-3 hover:text-fg"
                          >
                            <ShieldQuestion className="size-3.5" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-72" align="end" side="left">
                          <h4 className="mb-1.5 text-xs font-medium text-fg">
                            {t('access.explain.title')}
                          </h4>
                          <ul className="flex flex-col gap-1.5">
                            {entry.reasons.map((reason, index) => (
                              <li
                                key={index}
                                className="flex items-start gap-1.5 text-xs text-fg-secondary"
                              >
                                <Lock
                                  className="mt-0.5 size-3 shrink-0 text-fg-muted"
                                  aria-hidden
                                />
                                <span>
                                  {t(reason.messageKey, reason.params as Record<string, string>)}
                                  <Badge size="sm" className="ml-1.5">
                                    {t(`access.levels.${reason.level}`)}
                                  </Badge>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </PopoverContent>
                      </Popover>
                      {access.canManage && !inherited ? (
                        <button
                          type="button"
                          aria-label={t('common.actions.remove')}
                          onClick={() =>
                            revoke.mutate({ type: entry.principal.type, id: entry.principal.id })
                          }
                          className="rounded-xs p-1 text-fg-muted hover:bg-danger-subtle hover:text-danger"
                        >
                          <Unlink className="size-3.5" />
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className={cn('rounded-md border border-line bg-surface-2 p-3')}>
            <div className="flex items-center gap-2 text-sm text-fg">
              <Link2 className="size-4 text-fg-muted" aria-hidden />
              {t('access.share.linkSection')}
              <span className="ml-auto text-xs text-fg-muted">{t('access.share.linkOff')}</span>
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              Гостевая ссылка даёт просмотр одного объекта без входа. Создаётся в карточке объекта.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
