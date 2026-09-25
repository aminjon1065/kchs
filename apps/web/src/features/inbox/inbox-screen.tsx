import {
  INBOX_BULK_ACTION_KEY,
  INBOX_GROUPS,
  type InboxBulkOperation,
  type InboxBulkResult,
  type InboxGroup,
  type InboxItem,
  inboxGroupOf,
} from '@kchs/contracts'
import { formatDate, formatDateTime, formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  ObjectChip,
  ObjectIcon,
  PanelToolbar,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useHotkeys,
  useToast,
} from '@kchs/ui'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, Clock3, Inbox as InboxIcon, User } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useObjectActions } from '~/app/workspace/object-actions.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { inboxCountsQuery, keys } from '~/shared/api/queries.js'

type Scope = 'all' | 'mine' | 'delegated'
type Due = 'any' | 'overdue' | 'today' | 'week'
type GroupFilter = 'all' | InboxGroup

/** Дело подходит для массовой операции: есть её действие и ему ничего не нужно ввести. */
function bulkApplicable(item: InboxItem, operation: InboxBulkOperation): boolean {
  if (operation === 'snooze') return true
  const action = item.actions.find((entry) => entry.key === INBOX_BULK_ACTION_KEY[operation])
  return Boolean(
    action &&
      !action.requiresComment &&
      !action.requiresSecondFactor &&
      !action.input &&
      !action.openObject,
  )
}

export function InboxScreen() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)

  const [scope, setScope] = useState<Scope>('all')
  const [group, setGroup] = useState<GroupFilter>('all')
  const [due, setDue] = useState<Due>('any')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Отмеченные флажками дела — для массовых действий (ADR-0153)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())

  const filters = { state: 'open', scope, due, ...(group === 'all' ? {} : { group }) }
  // Дел бывает больше страницы: список догружается курсором, иначе часть дел
  // просто не видна (их у занятого сотрудника легко больше полусотни)
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: keys.inbox(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      http.get<{ items: InboxItem[]; nextCursor: string | null }>('/inbox', {
        query: { ...filters, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const { data: counts } = useQuery(inboxCountsQuery())

  // Во «всех видах» список разбит по группам: решения, ознакомления, поручения…
  const items = useMemo(() => {
    const loaded = data?.pages.flatMap((page) => page.items) ?? []
    if (group !== 'all') return loaded
    const rank = (item: InboxItem) => INBOX_GROUPS.indexOf(inboxGroupOf(item.kind))
    return [...loaded].sort((a, b) => rank(a) - rank(b))
  }, [data, group])
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null
  const groupCounts = useMemo(() => {
    const result: Record<InboxGroup, number> = {
      decide: 0,
      acknowledge: 0,
      instructions: 0,
      invites: 0,
      data: 0,
    }
    for (const [kind, count] of Object.entries(counts?.byKind ?? {})) {
      result[inboxGroupOf(kind)] += count
    }
    return result
  }, [counts])

  useEffect(() => {
    if (!selectedId && items[0]) setSelectedId(items[0].id)
  }, [items, selectedId])

  // Флажки остаются только у загруженных дел текущего фильтра
  useEffect(() => {
    setChecked((current) => {
      const visible = new Set(items.map((item) => item.id))
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [items])

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['inbox'] })
    void client.invalidateQueries({ queryKey: keys.inboxCounts })
  }

  const snooze = useMutation({
    mutationFn: (itemId: string) =>
      http.post(`/inbox/${itemId}/snooze`, {
        until: new Date(Date.now() + 24 * 3600_000).toISOString(),
      }),
    onSuccess: () => {
      toast.show({ title: t('inbox.snoozedUntilTomorrow'), tone: 'info' })
      refresh()
    },
  })

  const bulk = useMutation({
    mutationFn: (operation: InboxBulkOperation) =>
      http.post<InboxBulkResult>('/inbox/bulk', { ids: [...checked], operation }),
    onSuccess: (result) => {
      toast.show({
        title: t('inbox.bulk.result', { done: result.done, skipped: result.skipped }),
        tone: result.skipped > 0 ? 'warning' : 'success',
      })
      setChecked(new Set())
      refresh()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
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
    { combo: 'x', handler: () => selected && toggle(selected.id) },
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

  const checkedItems = items.filter((item) => checked.has(item.id))
  const applicable = (operation: InboxBulkOperation) =>
    checkedItems.filter((item) => bulkApplicable(item, operation)).length
  const allChecked = items.length > 0 && checkedItems.length === items.length
  const filtered = group !== 'all' || due !== 'any' || scope !== 'all'

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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,400px)_1fr]">
        <div className="flex min-h-0 flex-col border-r border-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <Select value={group} onValueChange={(next) => setGroup(next as GroupFilter)}>
              <SelectTrigger aria-label={t('inbox.groupLabel')} className="h-7 w-52 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t('inbox.groupOption', { name: t('inbox.groupAll'), count: counts?.total ?? 0 })}
                </SelectItem>
                {INBOX_GROUPS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t('inbox.groupOption', {
                      name: t(`inbox.groups.${value}`),
                      count: groupCounts[value],
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SegmentedControl
              size="sm"
              aria-label={t('inbox.dueLabel')}
              value={due}
              onValueChange={(next) => setDue(next as Due)}
              options={[
                { value: 'any', label: t('inbox.due.any') },
                { value: 'overdue', label: t('inbox.due.overdue') },
                { value: 'today', label: t('inbox.due.today') },
                { value: 'week', label: t('inbox.due.week') },
              ]}
            />
          </div>

          {items.length > 0 ? (
            <div
              className={cn(
                'flex min-h-9 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5',
                checked.size > 0 && 'bg-accent-subtle',
              )}
            >
              <Checkbox
                checked={allChecked ? true : checked.size > 0 ? 'indeterminate' : false}
                onCheckedChange={(value) =>
                  setChecked(value === true ? new Set(items.map((item) => item.id)) : new Set())
                }
                aria-label={t('inbox.selectAll')}
              />
              {checked.size === 0 ? (
                <span className="text-xs text-fg-muted">{t('inbox.selectAll')}</span>
              ) : (
                <>
                  <span className="text-xs font-medium text-fg">
                    {t('inbox.bulk.selected', { count: checked.size })}
                  </span>
                  {applicable('acknowledge') > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={bulk.isPending && bulk.variables === 'acknowledge'}
                      disabled={bulk.isPending}
                      onClick={() => bulk.mutate('acknowledge')}
                    >
                      {t('inbox.bulk.acknowledge', { count: applicable('acknowledge') })}
                    </Button>
                  ) : null}
                  {applicable('done') > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={bulk.isPending && bulk.variables === 'done'}
                      disabled={bulk.isPending}
                      onClick={() => bulk.mutate('done')}
                    >
                      {t('inbox.bulk.done', { count: applicable('done') })}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Clock3 className="size-3.5" />}
                    loading={bulk.isPending && bulk.variables === 'snooze'}
                    disabled={bulk.isPending}
                    onClick={() => bulk.mutate('snooze')}
                  >
                    {t('inbox.bulk.snooze')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
                    {t('inbox.bulk.clear')}
                  </Button>
                </>
              )}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
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
                title={filtered ? t('inbox.emptyFiltered') : t('inbox.empty')}
                description={filtered ? undefined : t('inbox.emptyHint')}
              />
            ) : (
              <>
                <ul className="divide-y divide-line" aria-label={t('inbox.title')}>
                  {items.map((item, index) => {
                    const itemGroup = inboxGroupOf(item.kind)
                    const heading =
                      group === 'all' &&
                      (index === 0 || inboxGroupOf(items[index - 1]?.kind ?? '') !== itemGroup)
                    return (
                      <li key={item.id}>
                        {heading ? (
                          <div className="flex items-center justify-between bg-surface-2 px-3 py-1 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                            <span>{t(`inbox.groups.${itemGroup}`)}</span>
                            <span className="tabular">{groupCounts[itemGroup]}</span>
                          </div>
                        ) : null}
                        <div
                          className={cn(
                            'flex items-start gap-2 pl-3',
                            selected?.id === item.id ? 'bg-accent-subtle' : 'hover:bg-surface-2',
                          )}
                        >
                          <Checkbox
                            className="mt-3"
                            checked={checked.has(item.id)}
                            onCheckedChange={() => toggle(item.id)}
                            aria-label={t('inbox.select', { title: item.title })}
                          />
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected?.id === item.id}
                            onClick={() => setSelectedId(item.id)}
                            className="flex min-w-0 flex-1 flex-col gap-1 py-2.5 pr-3 text-left"
                          >
                            <InboxRow item={item} />
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {hasNextPage ? (
                  <div className="p-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={isFetchingNextPage}
                      onClick={() => void fetchNextPage()}
                    >
                      {t('common.actions.loadMore')}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
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

/** Строка дела: заголовок, «срочно», инициатор, срок, замещение. */
function InboxRow({ item }: { item: InboxItem }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (
    <>
      <span className="flex items-center gap-2">
        <ObjectIcon type={item.object?.type ?? 'inbox'} className="size-4 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{item.title}</span>
        {item.priority === 'urgent' || item.priority === 'high' ? (
          <Badge tone="danger" size="sm">
            {t('inbox.urgent')}
          </Badge>
        ) : null}
      </span>
      <span className="flex items-center gap-2 text-xs text-fg-muted">
        {item.actor ? <span className="truncate">{item.actor.displayName}</span> : null}
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
    </>
  )
}

type InboxAction = InboxItem['actions'][number]

function InboxDetail({ item, onSnooze }: { item: InboxItem; onSnooze: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const requestObjectAction = useObjectActions((s) => s.request)
  const commentId = useId()
  const codeId = useId()
  const dateId = useId()
  const [commenting, setCommenting] = useState<InboxAction | null>(null)
  const [comment, setComment] = useState('')
  const [code, setCode] = useState('')
  const [date, setDate] = useState('')

  // Действие выполняет модуль элемента (POST /inbox/{id}/act): он же закрывает дело
  const act = useMutation({
    mutationFn: (input: { action: string; comment?: string; payload?: Record<string, unknown> }) =>
      http.post(`/inbox/${item.id}/act`, input),
    onSuccess: () => {
      toast.show({ title: t('inbox.resolved'), tone: 'success' })
      setCommenting(null)
      setComment('')
      setCode('')
      setDate('')
      void client.invalidateQueries({ queryKey: ['inbox'] })
      void client.invalidateQueries({ queryKey: keys.inboxCounts })
      if (item.object) void client.invalidateQueries({ queryKey: keys.object(item.object.id) })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const run = (action: InboxAction) => {
    // Форма в карточке объекта (резолюция, ADR-0084): открыть объект с намерением
    if (action.openObject && item.object) {
      requestObjectAction(item.object.id, action.key)
      openTab({
        kind: 'object',
        objectId: item.object.id,
        objectType: item.object.type,
        title: item.object.title,
        mode: 'permanent',
      })
      return
    }
    if (!action.requiresComment && !action.requiresSecondFactor && !action.input) {
      act.mutate({ action: action.key })
      return
    }
    setComment('')
    setCode('')
    setDate('')
    setCommenting(action)
  }

  // A — согласовать, R — отклонить (шпаргалка горячих клавиш, N84): те же кнопки дела;
  // в открытом диалоге клавиши не срабатывают — фокус в поле ввода
  useHotkeys([
    {
      combo: 'a',
      handler: () => {
        const approve = item.actions.find((action) => action.key === 'approve')
        if (approve && !act.isPending && !commenting) run(approve)
      },
    },
    {
      combo: 'r',
      handler: () => {
        const reject = item.actions.find((action) => action.key === 'reject')
        if (reject && !act.isPending && !commenting) run(reject)
      },
    },
  ])

  // Запрос продления: запрошенный срок и обоснование — в деле автора (ADR-0082)
  const requestedDueAt =
    typeof item.payload.requestedDueAt === 'string' ? item.payload.requestedDueAt : null
  const reason = typeof item.payload.reason === 'string' ? item.payload.reason : null
  const needsDate = commenting?.input === 'due_date'

  // Код второго фактора (подпись с MFA, ADR-0079) и новый срок (продление, ADR-0082)
  // уходят вместе с действием
  const submit = (action: InboxAction) => {
    const payload = {
      ...(action.requiresSecondFactor ? { code: code.trim() } : {}),
      ...(action.input === 'due_date' ? { dueDate: date } : {}),
    }
    act.mutate({
      action: action.key,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    })
  }
  const ready = (action: InboxAction) =>
    (!action.requiresComment || Boolean(comment.trim())) &&
    (!action.requiresSecondFactor || Boolean(code.trim())) &&
    (action.input !== 'due_date' || Boolean(date))

  return (
    <article className="mx-auto flex max-w-[760px] flex-col gap-4 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Badge tone="accent" size="sm">
            {t(`inbox.groups.${inboxGroupOf(item.kind)}`)}
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
      {requestedDueAt ? (
        <div className="flex flex-col gap-1 text-sm text-fg-secondary">
          <span>{t('inbox.requestedDue', { date: formatDate(requestedDueAt, { locale }) })}</span>
          {reason ? (
            <span className="whitespace-pre-line">{t('inbox.reason', { reason })}</span>
          ) : null}
        </div>
      ) : null}

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
                  disabled={!ready(commenting)}
                  loading={act.isPending}
                  onClick={() => submit(commenting)}
                >
                  {t(commenting.labelKey)}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              {needsDate ? (
                <Field label={t('inbox.dueDate')} htmlFor={dateId} required>
                  <Input
                    id={dateId}
                    type="date"
                    autoFocus
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </Field>
              ) : null}
              <Field
                // Новый срок просят с обоснованием — так и подписано поле
                label={t(needsDate ? 'inbox.justification' : 'inbox.comment')}
                htmlFor={commentId}
                required={commenting.requiresComment}
              >
                <Textarea
                  id={commentId}
                  autoFocus={!needsDate && !commenting.requiresSecondFactor}
                  rows={5}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </Field>
              {commenting.requiresSecondFactor ? (
                <Field label={t('inbox.code')} htmlFor={codeId} hint={t('inbox.codeHint')} required>
                  <Input
                    id={codeId}
                    autoFocus={!needsDate}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={24}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    mono
                  />
                </Field>
              ) : null}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </article>
  )
}
