import type { Bbox, LayerStyle, MapCamera } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  EmptyState,
  IconButton,
  InlineEdit,
  KeyValueList,
  MapCanvas,
  type MapClickEvent,
  MapLegend,
  NoAccessState,
  ObjectIcon,
  PanelToolbar,
  renderMapIcon,
  Skeleton,
  useMapTheme,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Map as MapIcon, Palette, Scan, Share2, Table2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, objectQuery } from '~/shared/api/queries.js'
import { registerPmtilesProtocol, useBasemapStyle } from './basemaps.js'
import { LayerEditSettings } from './edit/layer-edit-settings.js'
import { FeatureCard } from './feature-card.js'
import { layerSourceId, useRenderedLayers } from './layer-render.js'
import { gisKeys, layerQuery } from './queries.js'
import { LayerStylePanel } from './style-editor/style-editor.js'

/** Вид по умолчанию до загрузки экстента — Таджикистан (как у новой карты). */
const DEFAULT_CAMERA: MapCamera = { center: [69, 38.6], zoom: 6, bearing: 0, pitch: 0 }

/**
 * Слой (07-gis-engine.md §1–4, ADR-0064): представление датасета на карте —
 * просмотр со своей легендой, сведения о данных, «На новую карту». Данные
 * читаются с политиками смотрящего; права на слой данных не открывают.
 */
export function LayerView({
  objectId,
  tabId,
  savedState,
}: {
  objectId: string
  tabId: string
  savedState?: { camera?: MapCamera }
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const setTabState = useWorkspace((s) => s.setTabState)
  const openTab = useWorkspace((s) => s.openTab)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const [camera, setCamera] = useState<MapCamera | null>(savedState?.camera ?? null)
  const [fit, setFit] = useState<{ bbox: Bbox; key: number } | null>(null)
  const [picked, setPicked] = useState<{ rowId: string; point: [number, number] } | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // Редактор стиля: рабочая копия рисуется вместо сохранённого стиля (ADR-0075)
  const [styleOpen, setStyleOpen] = useState(false)
  const [draft, setDraft] = useState<LayerStyle | null>(null)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: layer, isLoading, error } = useQuery(layerQuery(objectId))
  const rendered = useRenderedLayers(
    layer ? [{ layer, visible: true, opacity: 1, style: draft }] : [],
    theme,
  )
  const basemap = useBasemapStyle(null, theme?.mode ?? 'light')

  useEffect(() => {
    if (camera) setTabState(tabId, { camera })
  }, [tabId, camera, setTabState])

  // Первое открытие — к охвату данных слоя
  const extent = layer?.extent ?? null
  useEffect(() => {
    if (!savedState?.camera && extent) setFit({ bbox: extent, key: 0 })
  }, [extent, savedState?.camera])

  const rename = useMutation({
    mutationFn: (name: string) => http.patch(`/gis/layers/${objectId}`, { name }),
    onSuccess: (_result, name) => {
      setTabTitle(tabId, name)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: gisKeys.layer(objectId) })
    },
  })

  const toMap = useMutation({
    mutationFn: async () => {
      if (!layer) throw new Error('no layer')
      return http.post<{ id: string }>('/gis/maps', {
        name: layer.name,
        spaceId: layer.spaceId,
        spec: {
          layers: [{ layerId: layer.id, visible: true, opacity: 1, group: null }],
          ...(camera ? { camera } : {}),
        },
      })
    },
    onSuccess: ({ id }) => {
      void client.invalidateQueries({ queryKey: ['objects'] })
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'map',
        title: layer?.name ?? t('objects.types.map'),
        mode: 'permanent',
      })
    },
    onError: (failure) =>
      toast.show({
        title: failure instanceof ApiError ? failure.message : t('errors.unknown'),
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
        <Skeleton className="h-[520px] w-full" />
      </div>
    )
  }
  if (error || !layer) return <EmptyState title={t('common.states.notFound')} />

  const level = object?.level ?? 'view'
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)
  const legend = rendered.legends.get(layer.id)
  const warnings = rendered.warnings.get(layer.id) ?? []

  const onFeatureClick = (event: MapClickEvent) => {
    const hit = event.features[0]
    if (!hit || hit.id === null) {
      setPicked(null)
      return
    }
    const count = Number(hit.properties.point_count ?? 1)
    if (count > 1) {
      const view = camera ?? DEFAULT_CAMERA
      setCamera({ ...view, center: event.lngLat, zoom: Math.min(22, view.zoom + 2) })
      return
    }
    setPicked({ rowId: String(hit.id), point: event.point })
  }

  return (
    <div ref={setRoot} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="layer" className="size-4 shrink-0 text-fg-muted" />
            <InlineEdit
              value={layer.name}
              disabled={!canEdit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('common.labels.name')}
            />
            <Badge size="sm">{t(`gis.layer.geometry.${layer.geometryType}`)}</Badge>
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            <Button
              variant={styleOpen ? 'subtle' : 'secondary'}
              size="sm"
              icon={<Palette className="size-3.5" />}
              aria-pressed={styleOpen}
              disabled={!layer.dataAccess}
              onClick={() => setStyleOpen((open) => !open)}
            >
              {t('gis.map.style')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<MapIcon className="size-3.5" />}
              loading={toMap.isPending}
              onClick={() => toMap.mutate()}
            >
              {t('gis.layer.toNewMap')}
            </Button>
            <IconButton
              label={t('gis.map.showAll')}
              disabled={!extent}
              onClick={() => extent && setFit({ bbox: extent, key: Date.now() })}
            >
              <Scan className="size-4" />
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
      {layer.dataAccess ? (
        <div
          className={
            styleOpen
              ? 'grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)_340px]'
              : 'grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]'
          }
        >
          <aside className="hidden min-h-0 flex-col gap-3 overflow-y-auto border-r border-line bg-surface-2 p-3 md:flex">
            {legend?.show ? (
              <div className="rounded-md border border-line bg-surface p-3">
                <MapLegend legend={legend} renderIcon={renderMapIcon} />
              </div>
            ) : null}
            <KeyValueList
              items={[
                {
                  key: 'features',
                  label: t('gis.layer.features'),
                  value: formatNumber(layer.featureCount, {}, { locale }),
                },
                {
                  key: 'geometry',
                  label: t('gis.layer.geometryField'),
                  value: layer.geometryField,
                },
                {
                  key: 'version',
                  label: t('gis.layer.dataVersion'),
                  value: String(layer.datasetVersion),
                },
              ]}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<Table2 className="size-3.5" />}
              onClick={() =>
                openTab({
                  kind: 'object',
                  objectId: layer.datasetId,
                  objectType: 'dataset',
                  title: layer.name,
                  mode: 'permanent',
                })
              }
            >
              {t('gis.layer.openDataset')}
            </Button>
            {warnings.length > 0 ? (
              <Callout tone="warning">
                {t('gis.layer.styleWarnings', { n: warnings.length })}
              </Callout>
            ) : null}
            {/* Правка объектов на карте и модерация (ADR-0076) — редактору слоя */}
            {canEdit ? <LayerEditSettings layer={layer} /> : null}
          </aside>
          <MapCanvas
            className="min-h-[320px]"
            basemapStyle={basemap.style}
            prepare={registerPmtilesProtocol}
            sources={rendered.sources}
            layers={rendered.layers}
            images={rendered.images}
            camera={camera ?? DEFAULT_CAMERA}
            fitBounds={fit}
            onCameraChange={setCamera}
            interactiveLayerIds={rendered.interactive}
            onFeatureClick={onFeatureClick}
            selection={
              picked
                ? [
                    {
                      source: layerSourceId(layer.id),
                      sourceLayer: 'layer',
                      id: Number(picked.rowId),
                    },
                  ]
                : []
            }
            aria-label={layer.name}
          >
            {picked ? (
              <div
                className="absolute z-20"
                style={{
                  left: `clamp(12px, ${picked.point[0] + 12}px, calc(100% - 300px))`,
                  top: `clamp(12px, ${picked.point[1] + 12}px, calc(100% - 240px))`,
                }}
              >
                <FeatureCard
                  key={picked.rowId}
                  layer={draft ? { ...layer, style: draft } : layer}
                  rowId={picked.rowId}
                  onClose={() => setPicked(null)}
                />
              </div>
            ) : null}
          </MapCanvas>
          {styleOpen ? (
            <aside className="hidden min-h-0 flex-col border-l border-line lg:flex">
              <LayerStylePanel
                layer={layer}
                draft={draft}
                onDraft={setDraft}
                warnings={warnings}
                onClose={() => setStyleOpen(false)}
              />
            </aside>
          ) : null}
        </div>
      ) : (
        <NoAccessState />
      )}

      <ShareDialog
        objectId={objectId}
        title={layer.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: layer.name })}
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
