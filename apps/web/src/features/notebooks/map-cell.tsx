import {
  type DatasetRecord,
  type LayerRecord,
  type MapCamera,
  type NotebookParams,
  notebookParamFields,
  notebookParamsFilter,
} from '@kchs/contracts'
import { Button, SegmentedControl } from '@kchs/ui'
import { Crosshair } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { MapEmbed } from '~/features/gis/map-embed.js'
import { useNotebook } from './notebook-context.js'
import { type CellMap, useCellValue, writeCell } from './notebook-doc.js'
import { ObjectPicker } from './object-picker.js'

type Source = 'map' | 'layer'

/**
 * Параметры тетради для слоя ячейки: территория — поле территории датасета,
 * период — поле времени слоя (иначе первое поле даты), как у ячеек-запросов.
 */
function paramsFilter(
  params: NotebookParams,
  layer: LayerRecord,
  dataset: DatasetRecord | undefined,
) {
  if (!dataset || (!params.period && !params.territory)) return null
  const time = layer.style.time?.field
  const fields = notebookParamFields(
    time ? { period: time } : undefined,
    dataset.fields,
    dataset.territoryField,
  )
  return notebookParamsFilter(params, fields)
}

/**
 * Ячейка карты (06-analytics-engine.md §11, ADR-0074): сохранённая карта или
 * слой по ссылке со своим видом; рендер — `MapEmbed` (как плитка дашборда).
 * Параметры тетради ограничивают тайлы слоёв; вид запоминается в ячейке.
 */
export function MapCell({ cell }: { cell: CellMap }) {
  const t = useT()
  const { spaceId, params, readOnly } = useNotebook()
  const mapId = useCellValue<string | null>(cell, 'mapId') ?? null
  const layerId = useCellValue<string | null>(cell, 'layerId') ?? null
  const camera = useCellValue<MapCamera | null>(cell, 'camera') ?? null
  const [picked, setPicked] = useState<Source>(layerId && !mapId ? 'layer' : 'map')
  const [current, setCurrent] = useState<MapCamera | null>(null)
  // Соавтор выбрал слой или карту — вид источника следует за документом
  const source: Source = mapId ? 'map' : layerId ? 'layer' : picked
  const chosen = source === 'map' ? mapId : layerId

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label={t('data.notebook.map.source')}
          size="sm"
          value={source}
          onValueChange={(next: Source) => {
            setPicked(next)
            if (!readOnly && (mapId || layerId)) {
              writeCell(cell, { mapId: null, layerId: null, camera: null })
            }
          }}
          options={(['map', 'layer'] as const).map((value) => ({
            value,
            label: t(`data.notebook.map.sources.${value}`),
          }))}
        />
        <ObjectPicker
          type={source}
          value={chosen}
          spaceId={spaceId}
          disabled={readOnly}
          label={t(`data.notebook.map.pick.${source}`)}
          placeholder={t(`data.notebook.map.pick.${source}`)}
          onChange={(id) =>
            writeCell(
              cell,
              source === 'map'
                ? { mapId: id, layerId: null, camera: null }
                : { layerId: id, mapId: null, camera: null },
            )
          }
        />
        {chosen && !readOnly ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Crosshair className="size-3.5" />}
            disabled={!current}
            onClick={() => current && writeCell(cell, { camera: current })}
          >
            {t('data.notebook.map.saveView')}
          </Button>
        ) : null}
      </div>
      {chosen ? (
        <div className="h-[360px] overflow-hidden rounded-md border border-line">
          <MapEmbed
            key={chosen}
            mapId={source === 'map' ? chosen : null}
            layerId={source === 'layer' ? chosen : null}
            camera={camera}
            filter={(layer, dataset) => paramsFilter(params, layer, dataset)}
            onCameraChange={setCurrent}
          />
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-muted">
          {t(`data.notebook.map.pick.${source}`)}
        </p>
      )}
      {chosen && (params.period || params.territory) ? (
        <p className="text-2xs text-fg-muted">{t('data.notebook.map.params')}</p>
      ) : null}
    </div>
  )
}
