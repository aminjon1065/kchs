import type { DatasetRecord } from '@kchs/contracts'
import { Button, useToast } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Map as MapIcon } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { datasetLayersQuery, gisKeys } from './queries.js'

/**
 * «На карте» у датасета с геометрией (ADR-0072): первый видимый пользователю
 * слой датасета, а нет его — новый слой со стилем по умолчанию в пространстве
 * датасета (нужно право создавать объекты в нём).
 */
export function ShowOnMapButton({ dataset }: { dataset: DatasetRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const open = useMutation({
    mutationFn: async () => {
      const layers = await client.fetchQuery(datasetLayersQuery(dataset.id))
      const existing = layers[0]
      if (existing) return existing
      const created = await http.post<{ id: string }>('/gis/layers', {
        name: dataset.name,
        spaceId: dataset.spaceId,
        datasetId: dataset.id,
      })
      void client.invalidateQueries({ queryKey: gisKeys.datasetLayers(dataset.id) })
      return { id: created.id, name: dataset.name }
    },
    onSuccess: (layer) =>
      openTab({
        kind: 'object',
        objectId: layer.id,
        objectType: 'layer',
        title: layer.name,
        mode: 'permanent',
      }),
    onError: (failure) =>
      toast.show({
        title: failure instanceof ApiError ? failure.message : t('errors.unknown'),
        tone: 'danger',
      }),
  })
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<MapIcon className="size-3.5" />}
      loading={open.isPending}
      onClick={() => open.mutate()}
    >
      {t('gis.layer.showOnMap')}
    </Button>
  )
}
