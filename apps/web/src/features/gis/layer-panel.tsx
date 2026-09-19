import type { LayerRecord, MapLayerEntry } from '@kchs/contracts'
import type { LegendModel } from '@kchs/map-style'
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  MapLegend,
  renderMapIcon,
} from '@kchs/ui'
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Layers,
  MoreHorizontal,
  Plus,
  Scan,
  Trash2,
} from 'lucide-react'
import { useT } from '~/app/i18n.js'

export interface PanelLayer {
  entry: MapLayerEntry
  /** null — слой ещё загружается или недоступен (удалён, нет прав). */
  layer: LayerRecord | null
  missing: boolean
}

export interface LayerPanelProps {
  layers: readonly PanelLayer[]
  legends: ReadonlyMap<string, LegendModel>
  canEdit: boolean
  onToggle: (layerId: string, visible: boolean) => void
  onOpacity: (layerId: string, opacity: number) => void
  onMove: (layerId: string, direction: 'up' | 'down') => void
  onRemove: (layerId: string) => void
  onZoom: (layerId: string) => void
  onOpenLayer: (layerId: string) => void
  onAdd: () => void
}

const OPACITIES = [1, 0.75, 0.5, 0.25] as const

/**
 * Панель «Слои» карты-студии (03-screens.md §10): сверху — то, что рисуется
 * поверх; видимость, прозрачность, порядок, «Показать всё», легенда видимого
 * слоя. Слой без доступа к данным остаётся в списке с пометкой.
 */
export function LayerPanel({
  layers,
  legends,
  canEdit,
  onToggle,
  onOpacity,
  onMove,
  onRemove,
  onZoom,
  onOpenLayer,
  onAdd,
}: LayerPanelProps) {
  const t = useT()
  // Порядок отрисовки — снизу вверх; в панели верхний слой — первым
  const ordered = [...layers].reverse()
  return (
    <section aria-label={t('gis.map.layers')} className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {t('gis.map.layers')}
        </h2>
        {canEdit ? (
          <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={onAdd}>
            {t('gis.map.addLayer')}
          </Button>
        ) : null}
      </div>
      {ordered.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title={t('gis.map.noLayers')}
          description={canEdit ? t('gis.map.noLayersHint') : undefined}
        />
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-3">
          {ordered.map(({ entry, layer, missing }, index) => {
            const name = layer?.name ?? t('gis.map.layerUnavailable')
            const legend = layer ? legends.get(layer.id) : undefined
            const noData = layer !== null && !layer.dataAccess
            return (
              <li key={entry.layerId} className="rounded-md border border-line bg-surface">
                <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
                  <Checkbox
                    checked={entry.visible}
                    disabled={!layer || noData}
                    onCheckedChange={(checked) => onToggle(entry.layerId, checked === true)}
                    aria-label={t('gis.map.toggleLayer', { name })}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm text-fg hover:text-accent disabled:text-fg-muted"
                    disabled={!layer || noData}
                    onClick={() => onZoom(entry.layerId)}
                    title={t('gis.map.zoomToLayer')}
                  >
                    {name}
                  </button>
                  {missing ? <Badge size="sm">{t('gis.map.layerUnavailable')}</Badge> : null}
                  {noData ? <Badge size="sm">{t('gis.map.noDataAccess')}</Badge> : null}
                  {entry.opacity < 1 ? (
                    <span className="shrink-0 text-xs tabular text-fg-muted">
                      {Math.round(entry.opacity * 100)}%
                    </span>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton label={t('gis.map.layerMenu', { name })} size="sm">
                        <MoreHorizontal className="size-4" aria-hidden />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={!layer?.extent}
                        icon={<Scan className="size-4" />}
                        onSelect={() => onZoom(entry.layerId)}
                      >
                        {t('gis.map.zoomToLayer')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!layer}
                        icon={<ExternalLink className="size-4" />}
                        onSelect={() => onOpenLayer(entry.layerId)}
                      >
                        {t('gis.map.openLayer')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>{t('gis.map.opacity')}</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={String(entry.opacity)}
                        onValueChange={(value) => onOpacity(entry.layerId, Number(value))}
                      >
                        {OPACITIES.map((opacity) => (
                          <DropdownMenuRadioItem key={opacity} value={String(opacity)}>
                            {Math.round(opacity * 100)}%
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={index === 0}
                        icon={<ArrowUp className="size-4" />}
                        onSelect={() => onMove(entry.layerId, 'up')}
                      >
                        {t('gis.map.moveUp')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === ordered.length - 1}
                        icon={<ArrowDown className="size-4" />}
                        onSelect={() => onMove(entry.layerId, 'down')}
                      >
                        {t('gis.map.moveDown')}
                      </DropdownMenuItem>
                      {canEdit ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            danger
                            icon={<Trash2 className="size-4" />}
                            onSelect={() => onRemove(entry.layerId)}
                          >
                            {t('gis.map.removeLayer')}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {entry.visible && legend?.show ? (
                  <div className="border-t border-line px-3 py-2">
                    <MapLegend legend={legend} renderIcon={renderMapIcon} />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
