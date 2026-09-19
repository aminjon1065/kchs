import { IconButton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { mapQuery } from '../queries.js'
import { useStudio } from './context.js'

// Макет печати, снимок и PDF — отдельным чанком: нужны только при печати
const PrintDialog = lazy(() =>
  import('../print/print-dialog.js').then((module) => ({ default: module.PrintDialog })),
)

/**
 * Печать и выгрузка карты (P2-E02 S06, ADR-0074): кнопка тулбара открывает
 * макет — текущий вид или лист A4/A3 с легендой, масштабом, севером и
 * атрибуцией — и выгружает PNG или PDF.
 */
export function PrintTools() {
  const t = useT()
  const { map, mapId, layers } = useStudio()
  const { data: record } = useQuery(mapQuery(mapId))
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-center rounded-md border border-line bg-surface p-0.5 shadow-sm">
      <IconButton
        label={t('gis.print.open')}
        size="sm"
        disabled={!map}
        onClick={() => setOpen(true)}
      >
        <Printer className="size-4" aria-hidden />
      </IconButton>
      {open && map ? (
        <Suspense fallback={null}>
          <PrintDialog
            map={map}
            name={record?.name ?? ''}
            layers={layers}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
