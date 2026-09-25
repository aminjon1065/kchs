import type {
  LayerRecord,
  MapLayerEntry,
  MapServiceEntry,
  ServiceLayerRecord,
} from '@kchs/contracts'
import type { LegendModel } from '@kchs/map-style'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  MapLegend,
  renderMapIcon,
} from '@kchs/ui'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns2,
  Download,
  ExternalLink,
  FileUp,
  Folder,
  FolderInput,
  Globe2,
  Layers,
  MoreHorizontal,
  Palette,
  Plus,
  Scan,
  Table2,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
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
  /** Правая панель стиля слоя (редактор стиля). */
  onStyle: (layerId: string) => void
  /** Нижняя панель: атрибутивная таблица слоя. */
  onAttributes: (layerId: string) => void
  onAdd: () => void
  /** Группа слоя в дереве (ADR-0160); null — без группы. */
  onGroup: (layerId: string, group: string | null) => void
  /** Видимость всех слоёв группы разом. */
  onToggleGroup: (group: string, visible: boolean) => void
  /** Файл геоданных сразу на карту: импорт в датасет и слой (ADR-0160). */
  onAddFile?: (() => void) | undefined
  /** Выгрузка видимых слоёв в геоформаты. */
  onExport?: (() => void) | undefined
  /** Шторка сравнения: слой справа от шторки есть, слева — нет (ADR-0160). */
  onCompare: (layerId: string) => void
  /** Слой под шторкой сейчас. */
  comparing: string | null
  /** Слои-ссылки на внешние ГИС-службы (ADR-0108): реестр и записи карты. */
  services: readonly MapServiceEntry[]
  serviceCatalog: readonly ServiceLayerRecord[]
  onToggleService: (serviceId: string, visible: boolean) => void
  onAddService: (serviceId: string) => void
  onRemoveService: (serviceId: string) => void
}

const OPACITIES = [1, 0.75, 0.5, 0.25] as const

/** Строки панели: слой без группы или группа из соседних слоёв с одной группой. */
type PanelBlock =
  | { kind: 'layer'; item: PanelLayer; index: number }
  | { kind: 'group'; name: string; items: Array<{ item: PanelLayer; index: number }> }

/** Верхний слой — первым; соседние слои одной группы — один узел дерева. */
export function panelBlocks(ordered: readonly PanelLayer[]): PanelBlock[] {
  const blocks: PanelBlock[] = []
  ordered.forEach((item, index) => {
    const group = item.entry.group
    const last = blocks[blocks.length - 1]
    if (group && last?.kind === 'group' && last.name === group) last.items.push({ item, index })
    else if (group) blocks.push({ kind: 'group', name: group, items: [{ item, index }] })
    else blocks.push({ kind: 'layer', item, index })
  })
  return blocks
}

/**
 * Панель «Слои» карты-студии (03-screens.md §10): сверху — то, что рисуется
 * поверх; видимость, прозрачность, порядок, группы, «Показать всё», легенда
 * видимого слоя. Слой без доступа к данным остаётся в списке с пометкой.
 */
export function LayerPanel({
  layers,
  legends,
  canEdit,
  onAdd,
  onAddFile,
  onExport,
  onToggleGroup,
  onGroup,
  services,
  serviceCatalog,
  onToggleService,
  onAddService,
  onRemoveService,
  ...actions
}: LayerPanelProps) {
  const t = useT()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [grouping, setGrouping] = useState<PanelLayer | null>(null)
  // Порядок отрисовки — снизу вверх; в панели верхний слой — первым
  const ordered = [...layers].reverse()
  const groups = [...new Set(layers.flatMap(({ entry }) => (entry.group ? [entry.group] : [])))]
  const item = ({ item: layer, index }: { item: PanelLayer; index: number }) => (
    <LayerItem
      key={layer.entry.layerId}
      {...layer}
      legend={layer.layer ? legends.get(layer.layer.id) : undefined}
      first={index === 0}
      last={index === ordered.length - 1}
      canEdit={canEdit}
      onGroup={() => setGrouping(layer)}
      {...actions}
    />
  )
  return (
    <section aria-label={t('gis.map.layers')} className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-1 px-3 py-2">
        <h2 className="mr-auto text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {t('gis.map.layers')}
        </h2>
        {onExport && ordered.length > 0 ? (
          <IconButton size="sm" label={t('gis.map.export.action')} onClick={onExport}>
            <Download className="size-4" />
          </IconButton>
        ) : null}
        {canEdit && onAddFile ? (
          <IconButton size="sm" label={t('gis.map.fileImport.action')} onClick={onAddFile}>
            <FileUp className="size-4" />
          </IconButton>
        ) : null}
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
          {panelBlocks(ordered).map((block) => {
            if (block.kind === 'layer') return item(block)
            const visible = block.items.filter(({ item: layer }) => layer.entry.visible).length
            const open = !collapsed.has(block.name)
            return (
              <li key={`group:${block.name}`} className="flex flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1">
                  <IconButton
                    size="sm"
                    label={t(open ? 'gis.map.groups.collapse' : 'gis.map.groups.expand', {
                      name: block.name,
                    })}
                    aria-expanded={open}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current)
                        if (next.has(block.name)) next.delete(block.name)
                        else next.add(block.name)
                        return next
                      })
                    }
                  >
                    {open ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </IconButton>
                  <Checkbox
                    checked={
                      visible === block.items.length ? true : visible > 0 ? 'indeterminate' : false
                    }
                    onCheckedChange={(checked) => onToggleGroup(block.name, checked === true)}
                    aria-label={t('gis.map.groups.toggle', { name: block.name })}
                  />
                  <Folder className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {block.name}
                  </span>
                  <span className="shrink-0 text-xs tabular text-fg-muted">
                    {block.items.length}
                  </span>
                </div>
                {open ? (
                  <ul
                    aria-label={block.name}
                    className="ml-3 flex flex-col gap-1 border-l border-line pl-2"
                  >
                    {block.items.map(item)}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <ServiceSection
        services={services}
        catalog={serviceCatalog}
        canEdit={canEdit}
        onToggle={onToggleService}
        onAdd={onAddService}
        onRemove={onRemoveService}
      />
      {grouping ? (
        <GroupDialog
          layerName={grouping.layer?.name ?? t('gis.map.layerUnavailable')}
          current={grouping.entry.group}
          groups={groups}
          onClose={() => setGrouping(null)}
          onSave={(group) => {
            onGroup(grouping.entry.layerId, group)
            setGrouping(null)
          }}
        />
      ) : null}
    </section>
  )
}

function LayerItem({
  entry,
  layer,
  missing,
  legend,
  first,
  last,
  canEdit,
  onToggle,
  onOpacity,
  onMove,
  onRemove,
  onZoom,
  onOpenLayer,
  onStyle,
  onAttributes,
  onGroup,
  onCompare,
  comparing,
}: PanelLayer &
  Pick<
    LayerPanelProps,
    | 'onToggle'
    | 'onOpacity'
    | 'onMove'
    | 'onRemove'
    | 'onZoom'
    | 'onOpenLayer'
    | 'onStyle'
    | 'onAttributes'
    | 'onCompare'
    | 'comparing'
  > & {
    legend: LegendModel | undefined
    first: boolean
    last: boolean
    canEdit: boolean
    onGroup: () => void
  }) {
  const t = useT()
  const name = layer?.name ?? t('gis.map.layerUnavailable')
  const noData = layer !== null && !layer.dataAccess
  return (
    <li className="rounded-md border border-line bg-surface">
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
              disabled={!layer || noData}
              icon={<Table2 className="size-4" />}
              onSelect={() => onAttributes(entry.layerId)}
            >
              {t('gis.map.attributes')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!layer}
              icon={<Palette className="size-4" />}
              onSelect={() => onStyle(entry.layerId)}
            >
              {t('gis.map.style')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!layer}
              icon={<ExternalLink className="size-4" />}
              onSelect={() => onOpenLayer(entry.layerId)}
            >
              {t('gis.map.openLayer')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<FolderInput className="size-4" />} onSelect={onGroup}>
              {t('gis.map.groups.assign')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!layer || noData}
              icon={<Columns2 className="size-4" />}
              onSelect={() => onCompare(entry.layerId)}
            >
              {comparing === entry.layerId ? t('gis.map.swipe.stop') : t('gis.map.swipe.start')}
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
              disabled={first}
              icon={<ArrowUp className="size-4" />}
              onSelect={() => onMove(entry.layerId, 'up')}
            >
              {t('gis.map.moveUp')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={last}
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
}

/** Группа слоя: новая по названию, одна из групп карты или без группы. */
function GroupDialog({
  layerName,
  current,
  groups,
  onClose,
  onSave,
}: {
  layerName: string
  current: string | null
  groups: readonly string[]
  onClose: () => void
  onSave: (group: string | null) => void
}) {
  const t = useT()
  const [name, setName] = useState(current ?? '')
  const trimmed = name.trim()
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.map.groups.title', { name: layerName })}
        size="sm"
        footer={
          <>
            {current ? (
              <Button variant="ghost" className="mr-auto" onClick={() => onSave(null)}>
                {t('gis.map.groups.ungroup')}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" disabled={!trimmed} onClick={() => onSave(trimmed)}>
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('gis.map.groups.name')} hint={t('gis.map.groups.hint')}>
            <Input
              autoFocus
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              aria-label={t('gis.map.groups.name')}
            />
          </Field>
          {groups.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {groups.map((group) => (
                <Button
                  key={group}
                  variant={group === trimmed ? 'secondary' : 'ghost'}
                  size="sm"
                  icon={<Folder className="size-3.5" />}
                  onClick={() => setName(group)}
                >
                  {group}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Внешние ГИС-службы карты: подложки под слоями данных (ADR-0108). */
function ServiceSection({
  services,
  catalog,
  canEdit,
  onToggle,
  onAdd,
  onRemove,
}: {
  services: readonly MapServiceEntry[]
  catalog: readonly ServiceLayerRecord[]
  canEdit: boolean
  onToggle: (serviceId: string, visible: boolean) => void
  onAdd: (serviceId: string) => void
  onRemove: (serviceId: string) => void
}) {
  const t = useT()
  const used = new Set(services.map((entry) => entry.serviceId))
  const rest = catalog.filter((service) => !used.has(service.id))
  if (catalog.length === 0) return null
  return (
    <div className="border-t border-line pt-2">
      <div className="flex items-center justify-between gap-2 px-3 py-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {t('gis.map.services')}
        </h2>
        {canEdit && rest.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label={t('gis.map.addService')}>
                <Plus className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {rest.map((service) => (
                <DropdownMenuItem key={service.id} onSelect={() => onAdd(service.id)}>
                  {service.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1 px-2 pb-3">
        {services.map((entry) => {
          const service = catalog.find((item) => item.id === entry.serviceId)
          const name = service?.name ?? t('gis.map.layerUnavailable')
          return (
            <li
              key={entry.serviceId}
              className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5"
            >
              <Checkbox
                checked={entry.visible}
                onCheckedChange={(checked) => onToggle(entry.serviceId, checked === true)}
                aria-label={t('gis.map.toggleLayer', { name })}
              />
              <Globe2 className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{name}</span>
              {canEdit ? (
                <IconButton
                  size="sm"
                  label={t('gis.map.removeService')}
                  onClick={() => onRemove(entry.serviceId)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
