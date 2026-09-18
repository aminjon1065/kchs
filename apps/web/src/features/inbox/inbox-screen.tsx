import type { InboxItem } from '@kchs/contracts'
import { formatDateTime, formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  ObjectChip,
  ObjectIcon,
  PanelToolbar,
  SegmentedControl,
  Skeleton,
  Textarea,
  useHotkeys,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, Clock3, Inbox as InboxIcon, User } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { inboxCountsQuery, inboxQuery, keys } from '~/shared/api/queries.js'

type Scope = 'all' | 'mine' | 'delegated'

export function InboxScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)

  const [scope, setScope] = useState<Scope>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data, isLoading } = useQuery(inboxQuery({ state: 'open', scope }))
  const { data: counts } = useQuery(inboxCountsQuery())

  const items = data?.items ?? []
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null

  useEffect(() => {
    if (!selectedId && items[0]) setSelectedId(items[0].id)
  }, [items, selectedId])

  const snooze = useMutation({
    mutationFn: (itemId: string) =>
      http.post(`/inbox/${itemId}/snooze`, {
        until: new Date(Date.now() + 24 * 3600_000).toISOString(),
      }),
    onSuccess: () => {
      toast.show({ title: t('inbox.snoozedUntilTomorrow'), tone: 'info' })
      void client.invalidateQueries({ queryKey: ['inbox'] })
      void client.invalidateQueries({ queryKey: keys.inboxCounts })
    },
  })

  const move = (delta: number): void => {
    if (items.length === 0) return
    const index = items.findIndex((item) => item.id === selected?.id)
    const next = Math.max(0, Math.min(items.length - 1, index + delta))
    setSelectedId(items[next]!.id)
  }

  useHotkeys([
    { combo: 'j', handler: () => move(1) },
    { combo: 'down', handler: () => move(1) },
    { combo: 'k', handler: () => move(-1) },
    { combo: 'up', handler: () => move(-1) },
    { combo: 's', handler: () => selected && snooze.mutate(selected.id) },
    {
      combo: 'e',
      handler: () => {
        if (selected?.object) {
          openTab({
            kind: 'object',
            objectId: selected.object.id,
            objectType: selected.object.type,
            title: selected.object.title,
            mode: 'permanent',
          })
        }
      },
    },
  ])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <h1 className="text-sm font-semibold text-fg">{t('inbox.title')}</h1>
            {counts ? (
              <span className="tabular text-xs text-fg-muted">
                {t('inbox.counts', { count: counts.total })}
              </span>
            ) : null}
            {counts && counts.overdue > 0 ? (
              <Badge tone="danger" size="sm">
                {t('common.time.overdue')}: {counts.overdue}
              </Badge>
            ) : null}
          </>
        }
        right={
          <SegmentedControl
            size="sm"
            aria-label={t('inbox.scopeLabel')}
            value={scope}
            onValueChange={(next) => setScope(next as Scope)}
            options={[
              { value: 'all', label: t('inbox.filters.all') },
              { value: 'mine', label: t('inbox.filters.mine') },
              { value: 'delegated', label: t('inbox.filters.delegated') },
            ]}
          />
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,380px)_1fr]">
        <div className="min-h-0 overflow-y-auto border-r border-line">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              compact
              icon={<InboxIcon />}
              title={t('inbox.empty')}
              description={t('inbox.emptyHint')}
            />
          ) : (
            <ul className="divide-y divide-line" aria-label={t('inbox.title')}>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected?.id === item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={cn(
                      'flex w-full flex-col gap-1 px-3 py-2.5 text-left',
                      selected?.id === item.id ? 'bg-accent-subtle' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <ObjectIcon
                        type={item.object?.type ?? 'inbox'}
                        className="size-4 shrink-0 text-fg-muted"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                        {item.title}
                      </span>
                      {item.priority === 'urgent' || item.priority === 'high' ? (
                        <Badge tone="danger" size="sm">
                          {t('inbox.urgent')}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-fg-muted">
                      {item.actor ? (
                        <span className="truncate">{item.actor.displayName}</span>
                      ) : null}
                      {item.dueAt ? (
                        <span
                          className={cn(
                            'flex items-center gap-1',
                            new Date(item.dueAt) < new Date() && 'text-danger',
                          )}
                        >
                          <Clock3 className="size-3" aria-hidden />
                          {formatRelativeTime(item.dueAt, { locale })}
                        </span>
                      ) : null}
                      {item.onBehalfOf ? (
                        <span className="flex items-center gap-1 text-warning">
                          <User className="size-3" aria-hidden />
                          {item.onBehalfOf.displayName}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto bg-canvas">
          {selected ? (
            <InboxDetail item={selected} onSnooze={() => snooze.mutate(selected.id)} />
          ) : (
            <EmptyState
              icon={<CheckCheck />}
              title={t('inbox.empty')}
              description={t('inbox.emptyHint')}
            />
          )}
        </div>
      </div>
    </div>
  )
}

type InboxAction = InboxItem['actions'][number]

function InboxDetail({ item, onSnooze }: { item: InboxItem; onSnooze: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const commentId = useId()
  const [commenting, setCommenting] = useState<InboxAction | null>(null)
  const [comment, setComment] = useState('')

  // Действие выполняет модуль элемента (POST /inbox/{id}/act): он же закрывает дело
  const act = useMutation({
    mutationFn: (input: { action: string; comment?: string }) =>
      http.post(`/inbox/${item.id}/act`, input),
    onSuccess: () => {
      toast.show({ title: t('inbox.resolved'), tone: 'success' })
      setCommenting(null)
      setComment('')
      void client.invalidateQueries({ queryKey: ['inbox'] })
      void client.invalidateQueries({ queryKey: keys.inboxCounts })
      if (item.object) void client.invalidateQueries({ queryKey: keys.object(item.object.id) })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const run = (action: InboxAction) => {
    if (!action.requiresComment) {
      act.mutate({ action: action.key })
      return
    }
    setComment('')
    setCommenting(action)
  }

  return (
    <article className="mx-auto flex max-w-[760px] flex-col gap-4 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Badge tone="accent" size="sm">
            {t(`inbox.groups.${groupOf(item.kind)}`)}
          </Badge>
          {item.dueAt ? (
            <span className={cn(new Date(item.dueAt) < new Date() && 'text-danger')}>
              {t('inbox.dueIn', { date: formatDateTime(item.dueAt, { locale }) })}
            </span>
          ) : null}
        </div>
        <h2 className="text-lg font-semibold text-fg">{item.title}</h2>
        {item.object ? (
          <div>
            <ObjectChip
              object={{ ...item.object }}
              onOpen={(object) =>
                openTab({
                  kind: 'object',
                  objectId: object.id,
                  objectType: object.type,
                  title: object.title,
                  mode: 'permanent',
                })
              }
            />
          </div>
        ) : null}
      </header>

      {item.body ? <p className="text-sm text-fg-secondary">{item.body}</p> : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {item.actions.map((action, index) => (
          <Button
            key={action.key}
            variant={index === 0 ? 'primary' : action.variant === 'danger' ? 'danger' : 'secondary'}
            loading={act.isPending && act.variables?.action === action.key}
            disabled={act.isPending}
            onClick={() => run(action)}
          >
            {t(action.labelKey)}
          </Button>
        ))}
        <Button variant="ghost" onClick={onSnooze} icon={<Clock3 className="size-4" />}>
          {t('inbox.actions.snooze')}
        </Button>
      </div>

      <Dialog open={commenting !== null} onOpenChange={(open) => !open && setCommenting(null)}>
        {commenting ? (
          <DialogContent
            title={t(commenting.labelKey)}
            description={item.title}
            size="md"
            footer={
              <>
                <Button variant="secondary" onClick={() => setCommenting(null)}>
                  {t('common.actions.cancel')}
                </Button>
                <Button
                  variant="primary"
                  disabled={!comment.trim()}
                  loading={act.isPending}
                  onClick={() => act.mutate({ action: commenting.key, comment: comment.trim() })}
                >
                  {t(commenting.labelKey)}
                </Button>
              </>
            }
          >
            <Field label={t('inbox.comment')} htmlFor={commentId} required>
              <Textarea
                id={commentId}
                autoFocus
                rows={5}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </Field>
          </DialogContent>
        ) : null}
      </Dialog>
    </article>
  )
}

function groupOf(kind: string): string {
  if (['approve', 'sign', 'resolve'].includes(kind)) return 'decide'
  if (kind === 'acknowledge') return 'acknowledge'
  if (kind.includes('instruction') || kind === 'accept_result') return 'instructions'
  if (kind === 'respond_invite') return 'invites'
  return 'data'
}
