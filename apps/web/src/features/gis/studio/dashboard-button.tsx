import { Button } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { AddToDashboardDialog } from '~/features/data/dashboard-dialogs.js'
import { mapQuery } from '../queries.js'
import { useStudio } from './context.js'

/**
 * «На дашборд» (P2-E02 S04, ADR-0074): сохранённая карта — плиткой на
 * существующий или новый дашборд пространства, как у графиков и показателей.
 */
export function AddMapToDashboard() {
  const t = useT()
  const { mapId, spaceId } = useStudio()
  const { data: record } = useQuery(mapQuery(mapId))
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<LayoutDashboard className="size-3.5" />}
        onClick={() => setOpen(true)}
      >
        {t('data.dashboard.addToDashboard')}
      </Button>
      {open ? (
        <AddToDashboardDialog
          source={{ kind: 'map', id: mapId, name: record?.name ?? '', spaceId }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
