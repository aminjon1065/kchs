import { type AnalysisRecord, type ChoroplethParams, choroplethLayerStyle } from '@kchs/contracts'
import { Button, useToast } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Map as MapIcon } from 'lucide-react'
import { ApiError } from '~/shared/api/errors.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { datasetLayersQuery, gisKeys } from '../queries.js'
import { gisChoroplethApi } from './queries.js'

/**
 * «Показать на карте» у готового хороплета: слой датасета-результата (нет его —
 * слой со стилем хороплета) на новой карте. Нужен, если мастер закрыли, пока
 * анализ считался, или слой удалили.
 */
export function ChoroplethMapButton({ analysis }: { analysis: AnalysisRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const show = useMutation({
    mutationFn: async () => {
      const datasetId = analysis.outputDatasetId as string
      const params = analysis.choropleth as ChoroplethParams
      const layers = await client.fetchQuery(datasetLayersQuery(datasetId))
      const layerId =
        layers[0]?.id ??
        (
          await gisChoroplethApi.postLayers({
            name: analysis.name,
            spaceId: analysis.spaceId,
            datasetId,
            style: choroplethLayerStyle(params),
          })
        ).id
      void client.invalidateQueries({ queryKey: gisKeys.datasetLayers(datasetId) })
      const map = await gisChoroplethApi.postMaps({
        name: analysis.name,
        spaceId: analysis.spaceId,
        spec: { layers: [{ layerId, visible: true, opacity: 1, group: null }] },
      })
      return map.id
    },
    onSuccess: (mapId) => {
      void client.invalidateQueries({ queryKey: ['objects'] })
      openTab({
        kind: 'object',
        objectId: mapId,
        objectType: 'map',
        title: analysis.name,
        mode: 'permanent',
      })
    },
    onError: (error) =>
      toast.show({
        title: error instanceof ApiError ? error.message : t('errors.unknown'),
        tone: 'danger',
      }),
  })
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<MapIcon className="size-3.5" />}
      loading={show.isPending}
      onClick={() => show.mutate()}
    >
      {t('gis.choropleth.showOnMap')}
    </Button>
  )
}
