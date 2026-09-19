import type { LayerRecord } from '@kchs/contracts'
import { Button } from '@kchs/ui'
import { ChartArea } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { ChoroplethWizard } from '../choropleth/choropleth-wizard.js'
import { useStudio } from './context.js'

/**
 * Анализ на карте (P2-E04 S04, ADR-0077): хороплет-мастер из тулбара студии.
 * С правом правки слой хороплета встаёт на эту карту несохранённой правкой —
 * «Сохранить карту» закрепляет его; без права — на новую карту.
 */
export function AnalysisTools() {
  const t = useT()
  const studio = useStudio()
  const [open, setOpen] = useState(false)

  const addLayer = (layerId: string) => {
    studio.editSpec((spec) => ({
      ...spec,
      layers: [...spec.layers, { layerId, visible: true, opacity: 1, group: null }],
    }))
    // К охвату нового слоя — когда сервер вернёт его запись
    void http
      .get<LayerRecord>(`/gis/layers/${layerId}`)
      .then((layer) => {
        if (layer.extent) studio.fitBounds(layer.extent)
      })
      .catch(() => undefined)
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        className="shadow-sm"
        icon={<ChartArea className="size-3.5" />}
        onClick={() => setOpen(true)}
      >
        {t('gis.choropleth.action')}
      </Button>
      {open ? (
        <ChoroplethWizard
          spaceId={studio.spaceId}
          currentMap={studio.canEdit ? { addLayer } : null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
