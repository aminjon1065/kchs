import type { FeatureGeometry, LayerRecord } from '@kchs/contracts'
import {
  AlertDialog,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  readMapTheme,
  Separator,
  useToast,
} from '@kchs/ui'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Crosshair,
  LocateFixed,
  Magnet,
  MapPin,
  MousePointer2,
  PencilLine,
  Pentagon,
  Redo2,
  Spline,
  Undo2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { datasetQuery } from '../../data/queries.js'
import { CoordinatesDialog, locate, locateErrorKey } from '../edit/coordinates-dialog.js'
import type { DrawController, DrawTool } from '../edit/draw-controller.js'
import { editApi, layerEditingQuery, snapFeaturesQuery } from '../edit/edit-api.js'
import { disposeEditStore, type EditTarget, editStore } from '../edit/edit-store.js'
import {
  bboxOf,
  type DrawKind,
  drawKindsFor,
  type GeometryPart,
  kindOf,
  mergeParts,
  sameGeometry,
  splitParts,
} from '../edit/geometry.js'
import { useEditLayersOnTop, useGhostOverlay } from '../edit/ghost-overlay.js'
import { SnapIndex } from '../edit/snap.js'
import { EDIT_TOOL, useStudio } from './context.js'

/** Привязка — с масштаба улиц: мельче вершины соседних объектов неразличимы. */
const SNAP_MIN_ZOOM = 12
/** Допуск привязки, px. */
const SNAP_TOLERANCE = 12
/** Поле охвата для объектов привязки: сдвиг карты не требует новых запросов. */
const SNAP_PADDING = 0.25

const NEW_TARGET: EditTarget = {
  rowId: null,
  ver: null,
  values: {},
  original: null,
  geometryLocked: false,
}

const DRAW_ICONS: Record<DrawKind, typeof MapPin> = {
  point: MapPin,
  line: Spline,
  polygon: Pentagon,
}

/** Охват карты с полем, округлённый наружу до сотых градуса, — ключ запросов привязки. */
function snapBbox(bounds: { west: number; south: number; east: number; north: number }): string {
  const dx = (bounds.east - bounds.west) * SNAP_PADDING
  const dy = (bounds.north - bounds.south) * SNAP_PADDING
  const down = (value: number) => Math.floor(value * 100) / 100
  const up = (value: number) => Math.ceil(value * 100) / 100
  const lon = (value: number) => Math.max(-180, Math.min(180, value))
  const lat = (value: number) => Math.max(-90, Math.min(90, value))
  return [
    down(lon(bounds.west - dx)),
    down(lat(bounds.south - dy)),
    up(lon(bounds.east + dx)),
    up(lat(bounds.north + dy)),
  ]
    .map((value) => (Object.is(value, -0) ? 0 : value))
    .join(',')
}

/**
 * Рисование и правка объектов (P2-E03 S01, 07-gis-engine.md §7, ADR-0076):
 * слой в режиме правки, инструменты «выбор / точка / линия / полигон», привязка
 * к вершинам и рёбрам видимых слоёв, координаты вручную и GPS. Черновик рисует
 * terra-draw (ленивый чанк), атрибуты, история и проверка — правая панель
 * `studio/edit-panel.tsx`; общее состояние — хранилище сеанса правки карты.
 */
export function EditTools() {
  const studio = useStudio()
  const { map, mapId } = studio
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const useSession = editStore(mapId)
  const layerId = useSession((s) => s.layerId)
  const tool = useSession((s) => s.tool)
  const target = useSession((s) => s.target)
  const geometry = useSession((s) => s.geometry)
  const values = useSession((s) => s.values)
  const snapping = useSession((s) => s.snapping)
  const ghost = useSession((s) => s.ghost)
  const controller = useSession((s) => s.controller)
  const canUndo = useSession((s) => s.past.length > 0)
  const canRedo = useSession((s) => s.future.length > 0)
  const [coordinates, setCoordinates] = useState<DrawKind | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [locating, setLocating] = useState(false)
  const [bbox, setBbox] = useState<string | null>(null)

  const layer = layerId ? (studio.layerById.get(layerId) ?? null) : null
  const access = useQuery({ ...layerEditingQuery(layerId ?? ''), enabled: layerId !== null })
  const { data: dataset } = useQuery({
    ...datasetQuery(layer?.datasetId ?? ''),
    enabled: Boolean(layer),
  })
  const kinds = layer ? drawKindsFor(layer.geometryType) : []

  // Обработчики карты и черновика живут дольше рендера — актуальное через ссылки
  const latest = useRef({ studio, defaults: {} as Record<string, unknown> })
  latest.current = {
    studio,
    // Новый объект — со значениями по умолчанию из схемы датасета
    defaults: Object.fromEntries(
      (dataset?.fields ?? [])
        .filter((field) => field.default !== undefined && field.type !== 'geometry')
        .map((field) => [field.key, field.default]),
    ),
  }

  useGhostOverlay(map, ghost)
  useEditLayersOnTop(map, layerId !== null)

  /** Шаг по истории черновика (ADR-0160): геометрия — в хранилище и в terra-draw. */
  const stepHistory = (direction: 'undo' | 'redo') => {
    const state = useSession.getState()
    if (state.target?.geometryLocked) return
    const next = direction === 'undo' ? state.undo() : state.redo()
    if (next === undefined) return
    state.controller?.load(next ? splitParts(next) : [])
  }
  const stepRef = useRef(stepHistory)
  stepRef.current = stepHistory

  // ⌘Z / Ctrl+Z — отменить, ⇧⌘Z / Ctrl+Y — повторить; в полях формы — их собственная отмена
  useEffect(() => {
    if (!layerId || !target) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const element = event.target as HTMLElement | null
      if (element?.closest('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        stepRef.current(event.shiftKey ? 'redo' : 'undo')
      } else if (key === 'y') {
        event.preventDefault()
        stepRef.current('redo')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layerId, target])

  // Студия закрыта — сеанс правки забыт
  useEffect(
    () => () => {
      editStore(mapId).getState().controller?.destroy()
      disposeEditStore(mapId)
    },
    [mapId],
  )

  /** Новый объект: черновик из нарисованной части, координат или GPS. */
  const openNew = (next: FeatureGeometry) => {
    const state = useSession.getState()
    state.open(NEW_TARGET, next, { ...latest.current.defaults })
    latest.current.studio.openPanel('edit', state.layerId)
  }

  // Черновик рисует terra-draw — отдельный чанк, только пока слой в режиме правки
  // biome-ignore lint/correctness/useExhaustiveDependencies: хранилище сеанса стабильно для карты
  useEffect(() => {
    if (!layerId || !map) return
    let cancelled = false
    let created: DrawController | null = null
    const onDraftChange = (parts: GeometryPart[]) => {
      const state = useSession.getState()
      const next = mergeParts(parts, state.multi)
      if (!state.target) {
        if (next) openNew(next)
        return
      }
      state.setGeometry(next)
    }
    void import('../edit/draw-controller.js').then(({ createDrawController }) => {
      if (cancelled) return
      const theme = readMapTheme(map.getContainer())
      created = createDrawController(map, {
        colors: {
          accent: theme.tokens.accent,
          surface: theme.surface,
          warning: theme.tokens.warning,
        },
        onChange: onDraftChange,
      })
      useSession.getState().setController(created)
    })
    // Смена подложки снимает слои черновика — пересоздаём их
    const onStyle = () => useSession.getState().controller?.rebuild()
    map.on('style.load', onStyle)
    return () => {
      cancelled = true
      map.off('style.load', onStyle)
      created?.destroy()
      useSession.getState().setController(null)
    }
  }, [layerId, map])

  /** Объект слоя с карты — в правку: геометрия в черновик, значения в форму. */
  const openFeature = async (rowId: string) => {
    const current = useSession.getState().layerId
    if (!current) return
    try {
      const feature = await editApi.feature(current, rowId)
      const shape = feature.geometry as FeatureGeometry | null
      const parts = shape ? splitParts(shape) : []
      // Внутренние границы terra-draw не правит — контур только для просмотра
      const locked = parts.some((part) => part.type === 'Polygon' && part.coordinates.length > 1)
      const state = useSession.getState()
      state.open(
        {
          rowId: feature.id,
          ver: feature.ver,
          values: feature.values,
          original: shape,
          geometryLocked: locked,
        },
        shape,
        feature.values,
      )
      if (!locked) state.controller?.load(parts)
      latest.current.studio.setSelection([{ layerId: current, rowId: feature.id }])
      latest.current.studio.openPanel('edit', current)
    } catch {
      toast.error(t('gis.feature.failed'))
    }
  }

  // Щелчок по объекту правимого слоя (инструмент «выбор», черновика нет)
  // biome-ignore lint/correctness/useExhaustiveDependencies: обработчик читает сеанс из хранилища
  useEffect(() => {
    if (!layerId || !map) return
    const onClick = (event: {
      point: { x: number; y: number }
      lngLat: { lng: number; lat: number }
    }) => {
      const state = useSession.getState()
      if (state.target || state.tool !== 'select') return
      const prefix = `kchs-data:${layerId}:`
      const ids = map
        .getStyle()
        .layers.map((item) => item.id)
        .filter((id) => id.startsWith(prefix) && !/:(label|cluster-count)$/.test(id))
      if (ids.length === 0) return
      const hit = map
        .queryRenderedFeatures([event.point.x, event.point.y], { layers: ids })
        .find((feature) => feature.id !== undefined && feature.id !== null)
      if (!hit) return
      // Скопление точек — приблизиться к нему
      if (Number(hit.properties?.point_count ?? 1) > 1) {
        map.easeTo({ center: event.lngLat, zoom: Math.min(22, map.getZoom() + 2) })
        return
      }
      void openFeature(String(hit.id))
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
    }
  }, [layerId, map])

  // Охват для привязки: объекты видимых слоёв с масштаба улиц
  useEffect(() => {
    if (!layerId || !map || !snapping) {
      setBbox(null)
      return
    }
    const update = () => {
      if (map.getZoom() < SNAP_MIN_ZOOM) {
        setBbox(null)
        return
      }
      const bounds = map.getBounds()
      setBbox(
        snapBbox({
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        }),
      )
    }
    update()
    map.on('moveend', update)
    return () => {
      map.off('moveend', update)
    }
  }, [layerId, map, snapping])

  const snapLayers: LayerRecord[] = bbox
    ? studio.layers.flatMap((item) =>
        item.entry.visible && item.layer?.dataAccess ? [item.layer] : [],
      )
    : []
  const snapQueries = useQueries({
    queries: snapLayers.map((item) => snapFeaturesQuery(item, bbox ?? '')),
  })
  const snapVersion = snapQueries.map((query) => query.dataUpdatedAt).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: результаты запросов — по отметкам обновления
  const snapIndex = useMemo(() => {
    const geometries: FeatureGeometry[] = []
    snapQueries.forEach((query, index) => {
      const source = snapLayers[index]
      for (const feature of query.data ?? []) {
        // Сам правимый объект — не цель привязки: вершины липли бы к прежнему контуру
        if (source?.id === layerId && feature.id === target?.rowId) continue
        if (feature.geometry) geometries.push(feature.geometry as FeatureGeometry)
      }
    })
    return new SnapIndex(geometries)
  }, [snapVersion, layerId, target?.rowId])

  useEffect(() => {
    controller?.setSnap(
      snapping && snapIndex.size > 0
        ? (point, projection) =>
            snapIndex.nearest(point, projection, SNAP_TOLERANCE)?.position ?? null
        : null,
    )
  }, [controller, snapping, snapIndex])

  const start = async (next: LayerRecord) => {
    try {
      const editing = await client.fetchQuery(layerEditingQuery(next.id))
      if (editing.mode === 'none') {
        toast.show({
          title: t(`gis.edit.denied.${editing.reason ?? 'no_rights'}`),
          tone: 'warning',
        })
        return
      }
      useSession.getState().start(next.id)
      studio.setActiveLayerId(next.id)
      studio.setTool(EDIT_TOOL)
      studio.openPanel('edit', next.id)
    } catch {
      toast.error(t('errors.unknown'))
    }
  }

  const stop = () => {
    useSession.getState().stop()
    studio.setTool(null)
    if (studio.panel?.kind === 'edit') studio.closePanel()
    studio.setSelection([])
  }

  const chooseTool = (next: DrawTool) => {
    const state = useSession.getState()
    if (next !== 'select' && state.target) return
    state.setTool(next)
    state.controller?.setTool(next)
  }

  /** Местоположение: у точечного слоя — точка объекта, иначе — карта к нему. */
  const gps = async () => {
    setLocating(true)
    try {
      const place = await locate()
      const here: [number, number] = [place.lon, place.lat]
      map?.easeTo({ center: here, zoom: Math.max(map.getZoom(), 16) })
      const state = useSession.getState()
      const pointDraft = !state.target || kindOf(state.geometry?.type ?? 'Point') === 'point'
      if (kinds.includes('point') && pointDraft && !state.multi && !state.target?.geometryLocked) {
        const point: FeatureGeometry = { type: 'Point', coordinates: here }
        if (state.target) state.setGeometry(point)
        else openNew(point)
        state.controller?.load(splitParts(point))
      }
      toast.show({
        title: t('gis.edit.gps.located', { accuracy: Math.round(place.accuracy) }),
        tone: 'info',
      })
    } catch (error) {
      toast.error(t(locateErrorKey(error)))
    } finally {
      setLocating(false)
    }
  }

  const applyCoordinates = (next: FeatureGeometry) => {
    const state = useSession.getState()
    if (state.target) state.setGeometry(next)
    else openNew(next)
    state.controller?.load(splitParts(next))
    const box = bboxOf(next)
    if (box) studio.fitBounds(box)
    setCoordinates(null)
  }

  if (!layerId) {
    const candidates = studio.layers.flatMap((item) => (item.layer?.dataAccess ? [item.layer] : []))
    if (candidates.length === 0) return null
    return (
      <div className="flex items-center rounded-md border border-line bg-surface p-0.5 shadow-sm">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" icon={<PencilLine className="size-3.5" />}>
              {t('gis.edit.start')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuLabel>{t('gis.edit.chooseLayer')}</DropdownMenuLabel>
            {candidates.map((item) => (
              <DropdownMenuItem
                key={item.id}
                disabled={!item.editable}
                onSelect={() => void start(item)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.name}</span>
                  {item.editable ? null : (
                    <span className="text-xs text-fg-muted">{t('gis.edit.layerReadonly')}</span>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  const dirty =
    target !== null &&
    (!sameGeometry(geometry, target.original) ||
      JSON.stringify(values) !== JSON.stringify(target.values))
  const coordinateKind: DrawKind =
    kindOf(geometry?.type ?? '') ??
    (tool !== 'select' ? tool : ((kinds.length === 1 ? kinds[0] : undefined) ?? 'point'))
  const pending = access.data?.canReview ? access.data.pending : 0

  return (
    <div
      role="toolbar"
      aria-label={t('gis.edit.toolbar')}
      className="flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-sm"
    >
      {/* Слой в правке — в заголовке панели; здесь — только вход в неё (узкая карта) */}
      <IconButton
        label={t('gis.edit.openPanel', { name: layer?.name ?? t('gis.map.layerUnavailable') })}
        onClick={() => studio.openPanel('edit', layerId)}
      >
        <PencilLine className="size-4 text-accent" aria-hidden />
      </IconButton>
      {access.data?.mode === 'suggest' ? (
        <Badge size="sm" tone="warning">
          {t('gis.edit.modeSuggest')}
        </Badge>
      ) : null}
      {pending > 0 ? (
        <Button
          variant="subtle"
          size="sm"
          onClick={() => {
            useSession.getState().setTab('edits')
            studio.openPanel('edit', layerId)
          }}
        >
          {t('gis.edit.pendingCount', { count: pending })}
        </Button>
      ) : null}
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <IconButton
        label={t('gis.edit.tools.select')}
        active={tool === 'select'}
        aria-pressed={tool === 'select'}
        onClick={() => chooseTool('select')}
      >
        <MousePointer2 className="size-4" aria-hidden />
      </IconButton>
      {kinds.map((kind) => {
        const Icon = DRAW_ICONS[kind]
        return (
          <IconButton
            key={kind}
            label={t(`gis.edit.tools.${kind}`)}
            active={tool === kind}
            aria-pressed={tool === kind}
            disabled={target !== null}
            onClick={() => chooseTool(kind)}
          >
            <Icon className="size-4" aria-hidden />
          </IconButton>
        )
      })}
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <IconButton
        label={t('gis.edit.tools.snap')}
        active={snapping}
        aria-pressed={snapping}
        onClick={() => useSession.getState().setSnapping(!snapping)}
      >
        <Magnet className="size-4" aria-hidden />
      </IconButton>
      <IconButton
        label={t('gis.edit.tools.coordinates')}
        disabled={target?.geometryLocked === true}
        onClick={() => setCoordinates(coordinateKind)}
      >
        <Crosshair className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={t('gis.edit.tools.gps')} disabled={locating} onClick={() => void gps()}>
        <LocateFixed className="size-4" aria-hidden />
      </IconButton>
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <IconButton
        label={t('gis.edit.tools.undo')}
        disabled={!canUndo || target?.geometryLocked === true}
        onClick={() => stepHistory('undo')}
      >
        <Undo2 className="size-4" aria-hidden />
      </IconButton>
      <IconButton
        label={t('gis.edit.tools.redo')}
        disabled={!canRedo || target?.geometryLocked === true}
        onClick={() => stepHistory('redo')}
      >
        <Redo2 className="size-4" aria-hidden />
      </IconButton>
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <Button
        variant="primary"
        size="sm"
        icon={<Check className="size-3.5" />}
        onClick={() => (dirty ? setLeaving(true) : stop())}
      >
        {t('gis.edit.finish')}
      </Button>
      {coordinates ? (
        <CoordinatesDialog
          kind={coordinates}
          geometry={geometry}
          onApply={applyCoordinates}
          onClose={() => setCoordinates(null)}
        />
      ) : null}
      <AlertDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={t('gis.edit.leaveTitle')}
        description={t('gis.edit.leaveBody')}
        confirmLabel={t('gis.edit.leaveConfirm')}
        destructive
        onConfirm={() => {
          setLeaving(false)
          stop()
        }}
      />
    </div>
  )
}
