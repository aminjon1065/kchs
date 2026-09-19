import type { AnalysisRecord, AnalysisRunStarted, AnalysisStatus, QueryStep } from '@kchs/contracts'
import { formatNumber, formatRelativeTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  type BadgeProps,
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  InlineEdit,
  type KeyValueItem,
  KeyValueList,
  ObjectChip,
  ObjectIcon,
  PanelToolbar,
  ProgressBar,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Share2, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { territoriesQuery } from '~/features/gis/queries.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, objectQuery } from '~/shared/api/queries.js'
import { exportJobQuery } from './queries.js'

const ACTIVE = new Set<AnalysisStatus>(['queued', 'running'])
const STATUS_TONES: Record<AnalysisStatus, BadgeProps['tone']> = {
  draft: 'neutral',
  queued: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
}
/** Параметры операции, которые показываются в карточке, — в порядке показа. */
const PARAM_LABELS: Record<string, string> = {
  distance: 'data.analysis.distance',
  size: 'data.analysis.size',
  limit: 'data.analysis.limit',
  maxDistance: 'data.analysis.maxDistance',
  level: 'data.analysis.level',
  by: 'data.analysis.dissolveBy',
  inside: 'data.analysis.inside',
  negate: 'data.analysis.negate',
  field: 'data.analysis.geometryField',
}

/** Анализ: опрашивается, пока запуск в очереди или выполняется. */
const analysisQuery = (id: string) =>
  queryOptions({
    queryKey: ['analysis', id] as const,
    queryFn: () => http.get<AnalysisRecord>(`/analyses/${id}`),
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.status) ? 1500 : false,
  })

type SpatialStep = Extract<QueryStep, { type: 'spatial' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Объект реестра чипом с переходом; не виден смотрящему — «нет доступа». */
function ObjectLink({ id }: { id: string }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: object, error } = useQuery({ ...objectQuery(id), retry: false })
  if (error) return <span className="text-fg-muted">{t('data.analysis.hidden')}</span>
  if (!object) return <Skeleton className="h-5 w-32" />
  return (
    <ObjectChip
      object={{ id: object.id, type: object.type, title: object.title }}
      onOpen={(item) =>
        openTab({
          kind: 'object',
          objectId: item.id,
          objectType: item.type,
          title: item.title,
          mode: 'permanent',
        })
      }
    />
  )
}

/** Цель операции: датасет, территория, территории уровня или геометрия. */
function TargetValue({ target }: { target: unknown }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: territories = [] } = useQuery(territoriesQuery())
  if (!isRecord(target)) return <>{t('common.labels.noValue')}</>
  if ((target.kind === 'dataset' || target.kind === 'query') && typeof target.id === 'string') {
    return <ObjectLink id={target.id} />
  }
  if (target.kind === 'territory') {
    const id = typeof target.id === 'string' ? target.id : null
    const found = id ? territories.find((item) => item.id === id) : undefined
    if (found) return <>{found.name[locale] ?? found.name.ru}</>
    if (typeof target.level === 'string') {
      return (
        <>
          {t('data.analysis.territoryLevel', {
            level: t(`gis.territories.levels.${target.level}`),
          })}
        </>
      )
    }
    return <>{t('data.analysis.territories')}</>
  }
  return <>GeoJSON</>
}

/**
 * Карточка пространственного анализа (07-gis-engine.md §10, ADR-0069):
 * операция и параметры, источники, состояние запуска и датасет-результат;
 * перезапуск — с правом правки.
 */
export function AnalysisView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)
  const openTab = useWorkspace((s) => s.openTab)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: analysis, isLoading } = useQuery(analysisQuery(objectId))
  const active = analysis ? ACTIVE.has(analysis.status) : false
  // Прогресс задания виден запустившему; остальным — только состояние анализа
  const { data: job } = useQuery({
    ...exportJobQuery(analysis?.jobId ?? ''),
    enabled: active && Boolean(analysis?.jobId),
    retry: false,
  })

  const rename = useMutation({
    mutationFn: (title: string) => http.patch(`/objects/${objectId}`, { title }),
    onSuccess: (_result, title) => {
      setTabTitle(tabId, title)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: ['analysis', objectId] })
    },
  })

  const rerun = useMutation({
    mutationFn: () => http.post<AnalysisRunStarted>(`/analyses/${objectId}/run`),
    onSuccess: () => {
      toast.show({ title: t('data.analysis.rerunStarted'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['analysis', objectId] })
    },
    onError: (error) =>
      toast.show({
        title: error instanceof ApiError ? error.message : t('errors.unknown'),
        tone: 'danger',
      }),
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
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (!analysis) return <EmptyState title={t('common.states.notFound')} />

  const level = object?.level ?? 'view'
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)
  const steps = analysis.query.steps ?? []
  const step = [...steps].reverse().find((item): item is SpatialStep => item.type === 'spatial')
  const source = analysis.query.source

  const paramItems: KeyValueItem[] = [
    {
      key: 'op',
      label: t('data.analysis.operation'),
      value: t(`data.analysis.ops.${analysis.kind}`),
    },
    {
      key: 'source',
      label: t('data.analysis.source'),
      value:
        source.kind === 'dataset' || source.kind === 'query' ? (
          <ObjectLink id={source.id} />
        ) : (
          t('data.analysis.territories')
        ),
    },
  ]
  if (step?.target !== undefined) {
    paramItems.push({
      key: 'target',
      label: t('data.analysis.target'),
      value: <TargetValue target={step.target} />,
    })
  }
  for (const [key, label] of Object.entries(PARAM_LABELS)) {
    const value = step?.params?.[key]
    if (value === undefined || value === null) continue
    let shown: ReactNode
    if (typeof value === 'number') shown = formatNumber(value, {}, { locale })
    else if (typeof value === 'boolean') shown = value ? t('data.analysis.yes') : null
    else if (key === 'level' && typeof value === 'string') {
      shown = t(`gis.territories.levels.${value}`)
    } else if (Array.isArray(value)) shown = value.join(', ')
    else shown = String(value)
    if (shown !== null) paramItems.push({ key, label: t(label), value: shown })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="analysis" className="size-4 shrink-0 text-fg-muted" />
            <InlineEdit
              value={analysis.name}
              disabled={!canEdit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('common.labels.name')}
            />
            <Badge size="sm" tone={STATUS_TONES[analysis.status]} dot>
              {t(`data.analysis.status.${analysis.status}`)}
            </Badge>
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            {canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Play className="size-3.5" />}
                disabled={active}
                loading={rerun.isPending}
                onClick={() => rerun.mutate()}
              >
                {t('data.analysis.rerun')}
              </Button>
            ) : null}
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
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          <Card title={t('data.analysis.result')}>
            <div className="flex flex-col gap-3">
              {active ? (
                <ProgressBar
                  value={job?.progress ?? 0}
                  label={t('data.analysis.running')}
                  showValue={job !== undefined}
                />
              ) : null}
              {analysis.status === 'failed' ? (
                <Callout tone="danger" title={t('data.analysis.failed')}>
                  {analysis.error}
                </Callout>
              ) : null}
              {analysis.outputDatasetId ? (
                <div className="flex flex-wrap items-center gap-3">
                  <ObjectLink id={analysis.outputDatasetId} />
                  {analysis.rowCount !== null ? (
                    <span className="text-sm text-fg-secondary">
                      {t('data.analysis.rows', { count: analysis.rowCount })}
                    </span>
                  ) : null}
                  {analysis.lastRunAt ? (
                    <span className="text-xs text-fg-muted">
                      {t('data.analysis.lastRun', {
                        when: formatRelativeTime(analysis.lastRunAt, { locale }),
                      })}
                    </span>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      openTab({
                        kind: 'object',
                        objectId: analysis.outputDatasetId as string,
                        objectType: 'dataset',
                        title: analysis.outputName,
                        mode: 'permanent',
                      })
                    }
                  >
                    {t('data.analysis.openResult')}
                  </Button>
                </div>
              ) : active ? null : (
                <p className="text-sm text-fg-muted">{t('data.analysis.noResult')}</p>
              )}
              {canEdit ? (
                <p className="text-xs text-fg-muted">{t('data.analysis.rerunHint')}</p>
              ) : null}
            </div>
          </Card>
          <Card title={t('data.analysis.parameters')}>
            <KeyValueList items={paramItems} />
          </Card>
          <Card title={t('data.analysis.inputs')}>
            <div className="flex flex-wrap gap-2">
              {analysis.inputDatasetIds.map((id) => (
                <ObjectLink key={id} id={id} />
              ))}
            </div>
          </Card>
        </div>
      </div>

      <ShareDialog
        objectId={objectId}
        title={analysis.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: analysis.name })}
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
