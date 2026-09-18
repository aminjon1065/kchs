import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Chart,
  EmptyState,
  IconButton,
  InlineEdit,
  NoAccessState,
  ObjectIcon,
  PanelToolbar,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutDashboard, RefreshCw, Share2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, objectQuery } from '~/shared/api/queries.js'
import { AddToDashboardDialog } from './dashboard-dialogs.js'
import { chartDataQuery, chartQuery, dataKeys } from './queries.js'

/**
 * График (06-analytics-engine.md §8): спецификация объекта и данные, посчитанные
 * с политиками смотрящего; нет доступа к данным — «нет доступа», а не ошибка.
 */
export function ChartView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [addingToDashboard, setAddingToDashboard] = useState(false)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: me } = useQuery(meQuery())
  const { data: chart, isLoading } = useQuery(chartQuery(objectId))
  const data = useQuery(chartDataQuery(objectId))

  const rename = useMutation({
    mutationFn: (name: string) => http.patch(`/charts/${objectId}`, { name }),
    onSuccess: (_result, name) => {
      setTabTitle(tabId, name)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: dataKeys.chart(objectId) })
    },
  })

  const trash = useMutation({
    mutationFn: () => http.delete(`/objects/${objectId}`),
    onSuccess: () => {
      toast.show({
        title: t('objects.trash.movedTo'),
        tone: 'info',
        action: {
          label: t('common.actions.undo'),
          onClick: () => void http.post(`/objects/${objectId}/restore`),
        },
      })
      void client.invalidateQueries({ queryKey: ['objects'] })
      closeTab(tabId)
    },
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }
  if (!chart) return <EmptyState title={t('common.states.notFound')} />

  const level = object?.level ?? 'view'
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)
  const noAccess =
    data.error instanceof ApiError && (data.error.status === 403 || data.error.status === 404)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="chart" className="size-4 shrink-0 text-fg-muted" />
            <InlineEdit
              value={chart.name}
              disabled={!canEdit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('common.labels.name')}
            />
            <Badge size="sm">{t(`data.chartTypes.${chart.spec.type}`)}</Badge>
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            <Button
              variant="secondary"
              size="sm"
              icon={<LayoutDashboard className="size-3.5" />}
              onClick={() => setAddingToDashboard(true)}
            >
              {t('data.dashboard.addToDashboard')}
            </Button>
            <IconButton
              label={t('data.chart.refresh')}
              onClick={() =>
                void client.invalidateQueries({ queryKey: dataKeys.chartData(objectId) })
              }
            >
              <RefreshCw className="size-4" />
            </IconButton>
            <IconButton label={t('common.actions.share')} onClick={() => setShareOpen(true)}>
              <Share2 className="size-4" />
            </IconButton>
            {canManage ? (
              <IconButton
                label={t('common.actions.delete')}
                variant="danger"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            ) : null}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-5">
        <div className="mx-auto max-w-[1100px] rounded-lg border border-line bg-surface p-4">
          {noAccess ? (
            <NoAccessState />
          ) : data.error ? (
            <Callout tone="danger">{t('data.chart.failed')}</Callout>
          ) : data.data ? (
            <Chart
              spec={chart.spec}
              result={data.data}
              height={520}
              pending={data.isFetching}
              {...(me?.user.timezone ? { timezone: me.user.timezone } : {})}
            />
          ) : (
            <Skeleton className="h-[520px] w-full" />
          )}
        </div>
      </div>

      {addingToDashboard ? (
        <AddToDashboardDialog
          source={{ kind: 'chart', id: chart.id, name: chart.name, spaceId: chart.spaceId }}
          onClose={() => setAddingToDashboard(false)}
        />
      ) : null}
      <ShareDialog
        objectId={objectId}
        title={chart.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: chart.name })}
        description={t('objects.trash.hint')}
        confirmLabel={t('common.actions.delete')}
        onConfirm={() => {
          trash.mutate()
          setDeleteOpen(false)
        }}
      />
    </div>
  )
}
