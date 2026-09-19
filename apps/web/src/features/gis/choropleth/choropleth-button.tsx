import type { DatasetRecord } from '@kchs/contracts'
import { Button } from '@kchs/ui'
import { ChartArea } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { choroplethReady } from './choropleth-form.js'
import { ChoroplethWizard } from './choropleth-wizard.js'

/**
 * «Хороплет» на экране датасета (ADR-0077): для датасета с геометрией или полем
 * территории — мастер с этим датасетом-источником; результат — в его пространстве.
 */
export function ChoroplethButton({ dataset }: { dataset: DatasetRecord }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!choroplethReady(dataset)) return null
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<ChartArea className="size-3.5" />}
        onClick={() => setOpen(true)}
      >
        {t('gis.choropleth.action')}
      </Button>
      {open ? (
        <ChoroplethWizard
          dataset={dataset}
          spaceId={dataset.spaceId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
