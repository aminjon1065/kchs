import { formatRelativeTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  ObjectIcon,
  PanelToolbar,
  SegmentedControl,
  Skeleton,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'
import { notificationsQuery } from '~/shared/api/queries.js'

export function NotificationsScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [unreadOnly, setUnreadOnly] = useState(false)

  const { data, isLoading } = useQuery(notificationsQuery(unreadOnly))

  const markAll = useMutation({
    mutationFn: () => http.post('/notifications/read', { all: true }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <h1 className="text-sm font-semibold text-fg">{t('notifications.title')}</h1>
            {data && data.unread > 0 ? (
              <Badge tone="accent" size="sm">
                {data.unread}
              </Badge>
            ) : null}
          </>
        }
        right={
          <>
            <SegmentedControl
              size="sm"
              aria-label={t('common.actions.filter')}
              value={unreadOnly ? 'unread' : 'all'}
              onValueChange={(next) => setUnreadOnly(next === 'unread')}
              options={[
                { value: 'all', label: t('common.actions.more') },
                { value: 'unread', label: t('notifications.unreadOnly') },
              ]}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<CheckCheck className="size-3.5" />}
              onClick={() => markAll.mutate()}
            >
              {t('notifications.markAllRead')}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : !data?.items.length ? (
          <EmptyState icon={<Bell />} title={t('notifications.empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    item.object &&
                    openTab({
                      kind: 'object',
                      objectId: item.object.id,
                      objectType: item.object.type,
                      title: item.object.title,
                      mode: 'permanent',
                    })
                  }
                  className={cn(
                    'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2',
                    !item.readAt && 'bg-accent-subtle/40',
                  )}
                >
                  {item.actor ? (
                    <Avatar name={item.actor.displayName} src={item.actor.avatarUrl} size="sm" />
                  ) : (
                    <ObjectIcon type="notification" className="mt-0.5 size-4 text-fg-muted" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-fg">{item.title}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-2xs text-fg-muted">
                      <Badge size="sm">{item.category}</Badge>
                      {formatRelativeTime(item.createdAt, { locale })}
                      {item.aggregateCount > 1 ? <span>· ×{item.aggregateCount}</span> : null}
                    </span>
                  </span>
                  {!item.readAt ? <span className="mt-1.5 size-2 rounded-full bg-accent" /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
