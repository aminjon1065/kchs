import { EmptyState } from '@kchs/ui'
import { Palette } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { LayerStylePanel } from '../style-editor/style-editor.js'
import { useStudio } from './context.js'

/**
 * Редактор стиля слоя с предпросмотром (P2-E01 S03, ADR-0075): рабочая копия —
 * в `useStudio().styleDrafts` и рисуется на карте вместо сохранённого стиля;
 * замечания компилятора — те, что дал рендер студии.
 */
export function StylePanel({ layerId }: { layerId: string | null }) {
  const t = useT()
  const studio = useStudio()
  const layer = layerId ? studio.layerById.get(layerId) : undefined
  if (!layer) {
    return <EmptyState compact icon={<Palette />} title={t('gis.style.noLayer')} />
  }
  return (
    <LayerStylePanel
      // Другой слой — другая панель: рабочая копия прежнего слоя снимается
      key={layer.id}
      layer={layer}
      draft={studio.styleDrafts[layer.id] ?? null}
      onDraft={(style) => studio.setStyleDraft(layer.id, style)}
      warnings={studio.warnings.get(layer.id) ?? []}
      onClose={studio.closePanel}
    />
  )
}
