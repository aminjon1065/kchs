import type { ChartFilter } from '@kchs/chart-spec'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Chart,
  type ChartHandle,
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
import { LayoutDashboard, Link2, RefreshCw, Share2, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { useLinkSource, usePaneLinkGroup, useViewContext } from '~/app/workspace/view-context.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { useLabelledResult } from '~/features/gis/result-labels.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, objectQuery } from '~/shared/api/queries.js'
import { brushFilter, brushLabel } from './brush-filter.js'
import { AddToDashboardDialog } from './dashboard-dialogs.js'
import { chartDataQuery, chartQuery, dataKeys, datasetQuery } from './queries.js'
import { chartHasImage, ResultExportMenu } from './result-export.js'

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
  const chartRef = useRef<ChartHandle | null>(null)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: me } = useQuery(meQuery())
  const { data: chart, isLoading } = useQuery(chartQuery(objectId))
  const data = useQuery(chartDataQuery(objectId))
  // Территории в разрезах — названиями единиц справочника
  const labelled = useLabelledResult(data.data)
  const locale = useAppearance((s) => s.locale)

  // Связанные представления (ADR-0073): кисть графика по датасету — фильтр
  // соседних панелей группы (карта, таблица датасета)
  const group = usePaneLinkGroup()
  const source = useLinkSource(group)
  const query = chart && 'query' in chart.spec.data ? chart.spec.data.query : null
  const datasetId = query?.source.kind === 'dataset' ? query.source.id : null
  const { data: dataset } = useQuery({
    ...datasetQuery(datasetId ?? ''),
    enabled: Boolean(group && datasetId),
  })
  const linkable = Boolean(group && dataset)

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
  // Данные графика по датасету или сохранённому запросу — выгрузкой; у показателя — только картинка
  const exportSpec =
    'query' in chart.spec.data
      ? chart.spec.data.query
      : 'queryId' in chart.spec.data
        ? { version: 1, source: { kind: 'query', id: chart.spec.data.queryId }, steps: [] }
        : null

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
            {data.data ? (
              <ResultExportMenu
                data={
                  exportSpec
                    ? {
                        path: '/queries/export',
                        body: { spec: exportSpec, params: chart.paramsDefaults, name: chart.name },
                      }
                    : null
                }
                chart={chartHasImage(chart.spec.type) ? chartRef : null}
                name={chart.name}
              />
            ) : null}
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
            <>
              {linkable ? (
                <p className="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
                  <Link2 className="size-3.5 text-accent" aria-hidden />
                  {t('data.chart.linkedBrush')}
                </p>
              ) : null}
              <Chart
                spec={
                  linkable
                    ? { ...chart.spec, options: { ...chart.spec.options, brush: true } }
                    : chart.spec
                }
                result={labelled ?? data.data}
                height={520}
                pending={data.isFetching}
                handleRef={chartRef}
                {...(me?.user.timezone ? { timezone: me.user.timezone } : {})}
                {...(linkable && group && dataset
                  ? {
                      onBrush: (picked: ChartFilter | null) => {
                        const store = useViewContext.getState()
                        const where = picked
                          ? brushFilter(chart.spec, picked, dataset.fields)
                          : null
                        if (!where) {
                          store.filter(group, dataset.id, null, source)
                          return
                        }
                        const field =
                          'field' in where
                            ? where.field
                            : 'and' in where && where.and[0] && 'field' in where.and[0]
                              ? where.and[0].field
                              : ''
                        const def = dataset.fields.find((item) => item.key === field)
                        const name = def ? (def.label[locale] ?? def.label.ru) : chart.name
                        store.filter(
                          group,
                          dataset.id,
                          { where, label: brushLabel(where, name, locale) },
                          source,
                        )
                      },
                    }
                  : {})}
              />
            </>
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
