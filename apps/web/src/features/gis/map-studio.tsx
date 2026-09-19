import type { Bbox, FilterNode, LayerRecord, LayerStyle, MapCamera, MapSpec } from '@kchs/contracts'
import {
  AlertDialog,
  Button,
  EmptyState,
  IconButton,
  InlineEdit,
  MapCanvas,
  type MapClickEvent,
  type MapInstance,
  ObjectIcon,
  PanelToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useMapTheme,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Scan, Share2, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, objectQuery } from '~/shared/api/queries.js'
import { AddLayerDialog } from './add-layer-dialog.js'
import { basemapsQuery, registerPmtilesProtocol, useBasemapStyle } from './basemaps.js'
import { FeatureCard } from './feature-card.js'
import { LayerPanel, type PanelLayer } from './layer-panel.js'
import { layerSourceId, type RenderEntry, useRenderedLayers } from './layer-render.js'
import { gisKeys, layerQuery, mapQuery } from './queries.js'
import { AttributeTable } from './studio/attribute-table.js'
import {
  type FeatureRef,
  type StudioContextValue,
  type StudioPanelKind,
  StudioProvider,
} from './studio/context.js'
import { CursorCoordinates } from './studio/cursor-coordinates.js'
import { AddMapToDashboard } from './studio/dashboard-button.js'
import { EditTools } from './studio/edit-tools.js'
import { NavigationTools } from './studio/navigation-tools.js'
import { PrintTools } from './studio/print-tools.js'
import { StudioSidePanel } from './studio/side-panel.js'
import { TimeBar } from './studio/time-bar.js'
import { TimeTools } from './studio/time-tools.js'

/** Состояние вкладки карты: вид и несохранённая правка — переживают смену вкладки. */
export interface MapTabState {
  camera?: MapCamera
  spec?: MapSpec
}

/** Отступ карточки объекта от точки щелчка и краёв карты, px. */
const CARD_OFFSET = 12
const CARD_WIDTH = 288

interface Picked extends FeatureRef {
  point: [number, number]
}

/** Общий охват рамок слоёв. */
function unionBbox(boxes: Array<Bbox | null | undefined>): Bbox | null {
  let out: Bbox | null = null
  for (const box of boxes) {
    if (!box) continue
    out = out
      ? [
          Math.min(out[0], box[0]),
          Math.min(out[1], box[1]),
          Math.max(out[2], box[2]),
          Math.max(out[3], box[3]),
        ]
      : box
  }
  return out
}

/**
 * Карта-студия (03-screens.md §10, 07-gis-engine.md §6, ADR-0072): подложка из
 * реестра, слои с видимостью, прозрачностью и порядком, легенда, карточка
 * объекта по щелчку. Каждый слой читается с правами смотрящего; вид и правка —
 * в состоянии вкладки, «Сохранить» записывает карту (слои, подложку, вид).
 * Инструменты, панели и таблица — слоты `studio/*` с общим `useStudio()`.
 */
export function MapStudio({
  objectId,
  tabId,
  savedState,
}: {
  objectId: string
  tabId: string
  savedState?: MapTabState
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const setTabState = useWorkspace((s) => s.setTabState)
  const openTab = useWorkspace((s) => s.openTab)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: map, isLoading, error } = useQuery(mapQuery(objectId))
  const [spec, setSpec] = useState<MapSpec | null>(savedState?.spec ?? null)
  const [camera, setCamera] = useState<MapCamera | null>(savedState?.camera ?? null)
  const [fit, setFit] = useState<{ bbox: Bbox; key: number } | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [selection, setSelection] = useState<FeatureRef[]>([])
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null)
  const [panel, setPanel] = useState<StudioContextValue['panel']>(null)
  const [attributesOpen, setAttributesOpen] = useState(false)
  const [layerFilters, setLayerFilters] = useState<Record<string, FilterNode>>({})
  const [styleDrafts, setStyleDrafts] = useState<Record<string, LayerStyle>>({})
  const [mapTool, setMapTool] = useState<string | null>(null)
  const [instance, setInstance] = useState<MapInstance | null>(null)
  const [adding, setAdding] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const current = spec ?? map?.spec ?? null
  const view = camera ?? current?.camera ?? null
  const dirty = Boolean(spec && map && JSON.stringify(spec) !== JSON.stringify(map.spec))

  useEffect(() => {
    setTabState(tabId, {
      ...(camera ? { camera } : {}),
      ...(dirty && spec ? { spec } : {}),
    } satisfies MapTabState)
  }, [tabId, camera, spec, dirty, setTabState])

  const layerQueries = useQueries({
    queries: (current?.layers ?? []).map((entry) => ({
      ...layerQuery(entry.layerId),
      retry: false,
    })),
  })
  const panelLayers: PanelLayer[] = (current?.layers ?? []).map((entry, index) => {
    const query = layerQueries[index]
    return {
      entry,
      layer: query?.data ?? null,
      missing: Boolean(query?.error),
    }
  })
  const entries: RenderEntry[] = panelLayers.flatMap(({ entry, layer }) =>
    layer
      ? [
          {
            layer,
            visible: entry.visible,
            opacity: entry.opacity,
            style: styleDrafts[layer.id] ?? null,
          },
        ]
      : [],
  )
  const time = current?.time ? `${current.time.from}/${current.time.to}` : null
  const rendered = useRenderedLayers(entries, theme, { filters: layerFilters, time })
  const basemap = useBasemapStyle(current?.basemapId ?? null, theme?.mode ?? 'light')
  const { data: basemaps = [] } = useQuery(basemapsQuery())

  const layerById = useMemo(() => {
    const out = new Map<string, LayerRecord>()
    for (const item of panelLayers) if (item.layer) out.set(item.layer.id, item.layer)
    return out
  }, [panelLayers])

  const level = object?.level ?? 'view'
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)

  const edit = (change: (spec: MapSpec) => MapSpec) => {
    if (!current) return
    setSpec(change(current))
  }
  const editEntry = (layerId: string, patch: Partial<MapSpec['layers'][number]>) =>
    edit((value) => ({
      ...value,
      layers: value.layers.map((entry) =>
        entry.layerId === layerId ? { ...entry, ...patch } : entry,
      ),
    }))

  const save = useMutation({
    mutationFn: () =>
      http.patch(`/gis/maps/${objectId}`, {
        spec: { ...(current as MapSpec), ...(view ? { camera: view } : {}) },
      }),
    onSuccess: () => {
      toast.show({ title: t('gis.map.saved'), tone: 'success' })
      setSpec(null)
      void client.invalidateQueries({ queryKey: gisKeys.map(objectId) })
    },
    onError: (failure) =>
      toast.show({
        title: failure instanceof ApiError ? failure.message : t('errors.unknown'),
        tone: 'danger',
      }),
  })

  const rename = useMutation({
    mutationFn: (name: string) => http.patch(`/gis/maps/${objectId}`, { name }),
    onSuccess: (_result, name) => {
      setTabTitle(tabId, name)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: gisKeys.map(objectId) })
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

  const onFeatureClick = (event: MapClickEvent) => {
    // Щелчки забрал инструмент карты (правка, измерение) — без карточки объекта
    if (mapTool) return
    const hit = event.features[0]
    if (!hit) {
      setPicked(null)
      setSelection([])
      return
    }
    const layerId = hit.source.replace(/^layer-/, '')
    const count = Number(hit.properties.point_count ?? 1)
    // Скопление — приблизиться к нему; одиночная точка кластера — как объект
    if (count > 1 && view) {
      setCamera({ ...view, center: event.lngLat, zoom: Math.min(22, view.zoom + 2) })
      setPicked(null)
      return
    }
    if (hit.id === null) return
    const ref = { layerId, rowId: String(hit.id) }
    setPicked({ ...ref, point: event.point })
    setSelection([ref])
    setActiveLayerId(layerId)
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    )
  }
  if (error || !map || !current || !view) {
    return <EmptyState title={t('common.states.notFound')} />
  }

  const showAll = () => {
    const bbox = unionBbox(
      panelLayers.filter((item) => item.entry.visible).map((item) => item.layer?.extent),
    )
    if (bbox) setFit({ bbox, key: Date.now() })
  }
  const pickedSaved = picked ? layerById.get(picked.layerId) : undefined
  // Карточка — по рабочей копии стиля, если его сейчас правят (настройка карточки)
  const pickedDraft = pickedSaved ? styleDrafts[pickedSaved.id] : undefined
  const pickedLayer =
    pickedSaved && pickedDraft ? { ...pickedSaved, style: pickedDraft } : pickedSaved

  const studio: StudioContextValue = {
    mapId: objectId,
    spaceId: map.spaceId,
    map: instance,
    spec: current,
    editSpec: edit,
    canEdit,
    layers: panelLayers,
    layerById,
    camera: view,
    setCamera,
    fitBounds: (bbox) => setFit({ bbox, key: Date.now() }),
    selection,
    setSelection,
    activeLayerId,
    setActiveLayerId,
    panel,
    openPanel: (kind: StudioPanelKind, layerId: string | null = activeLayerId) =>
      setPanel({ kind, layerId }),
    closePanel: () => setPanel(null),
    attributesOpen,
    setAttributesOpen,
    layerFilters,
    setLayerFilter: (layerId, filter) =>
      setLayerFilters((previous) => {
        const next = { ...previous }
        if (filter) next[layerId] = filter
        else delete next[layerId]
        return next
      }),
    legends: rendered.legends,
    warnings: rendered.warnings,
    styleDrafts,
    setStyleDraft: (layerId, style) =>
      setStyleDrafts((previous) => {
        const next = { ...previous }
        if (style) next[layerId] = style
        else delete next[layerId]
        return next
      }),
    mapTool,
    setMapTool: (tool) => {
      setMapTool(tool)
      if (tool) setPicked(null)
    },
  }

  return (
    <StudioProvider value={studio}>
      <div ref={setRoot} className="flex h-full min-h-0 flex-col">
        <PanelToolbar
          left={
            <>
              <ObjectIcon type="map" className="size-4 shrink-0 text-fg-muted" />
              <InlineEdit
                value={map.name}
                disabled={!canEdit}
                onSave={(next) => rename.mutate(next)}
                className="text-sm font-semibold text-fg"
                aria-label={t('common.labels.name')}
              />
            </>
          }
          right={
            <>
              <PresenceAvatars objectId={objectId} />
              <Select
                value={current.basemapId ?? basemap.basemap?.id ?? ''}
                onValueChange={(value) => edit((spec) => ({ ...spec, basemapId: value }))}
              >
                <SelectTrigger className="h-7 w-48" aria-label={t('gis.map.basemap')}>
                  <SelectValue placeholder={t('gis.map.basemap')} />
                </SelectTrigger>
                <SelectContent>
                  {basemaps.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.key === 'none' ? t('admin.basemaps.noneName') : item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <IconButton label={t('gis.map.showAll')} onClick={showAll}>
                <Scan className="size-4" />
              </IconButton>
              <AddMapToDashboard />
              {canEdit && (dirty || camera) ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Save className="size-3.5" />}
                  loading={save.isPending}
                  onClick={() => save.mutate()}
                >
                  {t('gis.map.save')}
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
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[280px] shrink-0 flex-col border-r border-line bg-surface-2 md:flex">
            <LayerPanel
              layers={panelLayers}
              legends={rendered.legends}
              canEdit={canEdit}
              onToggle={(layerId, visible) => editEntry(layerId, { visible })}
              onOpacity={(layerId, opacity) => editEntry(layerId, { opacity })}
              onMove={(layerId, direction) =>
                edit((value) => {
                  const layers = [...value.layers]
                  const index = layers.findIndex((entry) => entry.layerId === layerId)
                  // «Выше» в панели — позже в порядке отрисовки
                  const target = direction === 'up' ? index + 1 : index - 1
                  if (index < 0 || target < 0 || target >= layers.length) return value
                  const [moved] = layers.splice(index, 1)
                  if (moved) layers.splice(target, 0, moved)
                  return { ...value, layers }
                })
              }
              onRemove={(layerId) =>
                edit((value) => ({
                  ...value,
                  layers: value.layers.filter((entry) => entry.layerId !== layerId),
                }))
              }
              onZoom={(layerId) => {
                const extent = layerById.get(layerId)?.extent
                if (extent) setFit({ bbox: extent, key: Date.now() })
              }}
              onOpenLayer={(layerId) =>
                openTab({
                  kind: 'object',
                  objectId: layerId,
                  objectType: 'layer',
                  title: layerById.get(layerId)?.name ?? t('objects.types.layer'),
                  mode: 'permanent',
                })
              }
              onStyle={(layerId) => {
                setActiveLayerId(layerId)
                setPanel({ kind: 'style', layerId })
              }}
              onAttributes={(layerId) => {
                setActiveLayerId(layerId)
                setAttributesOpen(true)
              }}
              onAdd={() => setAdding(true)}
            />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <MapCanvas
              className="min-h-[320px] flex-1"
              basemapStyle={basemap.style}
              prepare={registerPmtilesProtocol}
              sources={rendered.sources}
              layers={rendered.layers}
              images={rendered.images}
              camera={view}
              fitBounds={fit}
              onCameraChange={setCamera}
              interactiveLayerIds={rendered.interactive}
              onFeatureClick={onFeatureClick}
              onMapReady={setInstance}
              selection={selection.map((ref) => ({
                source: layerSourceId(ref.layerId),
                sourceLayer: 'layer',
                id: Number(ref.rowId),
              }))}
              aria-label={map.name}
            >
              <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
                <div className="pointer-events-auto flex items-center gap-1">
                  <NavigationTools />
                  <EditTools />
                  <TimeTools />
                  <PrintTools />
                </div>
              </div>
              <TimeBar />
              <CursorCoordinates />
              {picked && pickedLayer ? (
                <div
                  className="absolute z-20"
                  style={{
                    left: `clamp(${CARD_OFFSET}px, ${picked.point[0] + CARD_OFFSET}px, calc(100% - ${CARD_WIDTH + CARD_OFFSET}px))`,
                    top: `clamp(${CARD_OFFSET}px, ${picked.point[1] + CARD_OFFSET}px, calc(100% - 240px))`,
                  }}
                >
                  <FeatureCard
                    key={`${picked.layerId}:${picked.rowId}`}
                    layer={pickedLayer}
                    rowId={picked.rowId}
                    onClose={() => {
                      setPicked(null)
                      setSelection([])
                    }}
                  />
                </div>
              ) : null}
            </MapCanvas>
            {attributesOpen ? <AttributeTable /> : null}
          </div>
          {panel ? (
            <aside className="hidden w-[340px] shrink-0 flex-col border-l border-line bg-surface lg:flex">
              <StudioSidePanel />
            </aside>
          ) : null}
        </div>

        {adding ? (
          <AddLayerDialog
            spaceId={map.spaceId}
            present={new Set(current.layers.map((entry) => entry.layerId))}
            onAdd={(layerId) =>
              edit((value) => ({
                ...value,
                layers: [...value.layers, { layerId, visible: true, opacity: 1, group: null }],
              }))
            }
            onClose={() => setAdding(false)}
          />
        ) : null}
        <ShareDialog
          objectId={objectId}
          title={map.name}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
        <AlertDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t('objects.deleteConfirm', { title: map.name })}
          description={t('objects.trash.hint')}
          confirmLabel={t('common.actions.delete')}
          onConfirm={() => {
            trash.mutate()
            setDeleteOpen(false)
          }}
        />
      </div>
    </StudioProvider>
  )
}
