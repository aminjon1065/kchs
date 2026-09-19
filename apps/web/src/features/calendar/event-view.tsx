import {
  Button,
  EmptyState,
  ErrorState,
  NoAccessState,
  ObjectIcon,
  PanelToolbar,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Pencil, Share2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError } from '~/shared/api/client.js'
import { EventDetails } from './event-details.js'
import { EventEditor } from './event-editor.js'
import { eventQuery } from './queries.js'

/** Событие во вкладке: карточка целиком, правка, доступ; обсуждение — в правой панели. */
export function EventView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const { data: record, isLoading, error, refetch } = useQuery(eventQuery(objectId))

  useEffect(() => {
    if (record && !record.busy) setTabTitle(tabId, record.title)
  }, [record, tabId, setTabTitle])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }
  if (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return <NoAccessState />
    }
    return (
      <ErrorState
        description={error instanceof ApiError ? error.message : t('errors.unknown')}
        onRetry={() => refetch()}
      />
    )
  }
  if (!record) return <EmptyState title={t('common.states.notFound')} />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="event" className="size-4 shrink-0 text-fg-muted" />
            <span className="truncate text-sm font-semibold text-fg">
              {record.busy ? t('calendar.busy') : record.title}
            </span>
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            {record.can.manage ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Share2 className="size-3.5" />}
                onClick={() => setSharing(true)}
              >
                {t('calendar.sidebar.share')}
              </Button>
            ) : null}
            {record.can.edit ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Pencil className="size-3.5" />}
                onClick={() => setEditing(true)}
              >
                {t('calendar.event.edit')}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        <div className="mx-auto max-w-[760px] p-6">
          <div className="rounded-lg border border-line bg-surface p-5">
            <EventDetails
              record={record}
              onEdit={() => setEditing(true)}
              onClosed={() => closeTab(tabId)}
            />
          </div>
        </div>
      </div>
      {editing ? (
        <EventEditor
          target={{ mode: 'edit', record, occurrence: null }}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {sharing ? (
        <ShareDialog
          objectId={objectId}
          title={record.title}
          open
          onOpenChange={(open) => !open && setSharing(false)}
        />
      ) : null}
    </div>
  )
}
