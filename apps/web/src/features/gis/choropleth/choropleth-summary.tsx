import {
  type AnalysisRecord,
  type ChoroplethParams,
  choroplethLayerStyle,
  type DatasetRecord,
  type Locale,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import { Button, type KeyValueItem, useToast } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Map as MapIcon } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { datasetLayersQuery, gisKeys } from '../queries.js'

type Translate = ReturnType<typeof useT>

/** Параметры хороплета строками карточки анализа: связь, уровень, мера, нормализация, классы. */
export function choroplethParamItems(
  params: ChoroplethParams,
  dataset: DatasetRecord | undefined,
  t: Translate,
  locale: Locale,
): KeyValueItem[] {
  const labelOf = (key: string | null) => {
    const field = dataset?.fields.find((item) => item.key === key)
    return field ? (field.label[locale] ?? field.label.ru) : (key ?? '')
  }
  const measure = t(`gis.choropleth.measureNames.${params.measure.agg}`, {
    field: labelOf(params.measure.field),
  })
  const items: KeyValueItem[] = [
    {
      key: 'join',
      label: t('gis.choropleth.join'),
      value: t(`gis.choropleth.joinHints.${params.join}`, { field: labelOf(params.field) }),
    },
    {
      key: 'level',
      label: t('gis.choropleth.level'),
      value: t(`gis.choropleth.levels.${params.level}`),
    },
    { key: 'measure', label: t('gis.choropleth.measure'), value: measure },
    {
      key: 'normalize',
      label: t('gis.choropleth.normalize'),
      value:
        params.normalize === 'none'
          ? t('gis.choropleth.normalizations.none')
          : t(`gis.choropleth.per.${params.normalize}`, {
              n: formatNumber(params.per, {}, { locale }),
            }),
    },
    {
      key: 'style',
      label: t('gis.choropleth.method'),
      value: t('gis.choropleth.styleSummary', {
        method: t(`gis.choropleth.methods.${params.style.method}`),
        classes: params.style.classes,
        palette: t(`gis.choropleth.palettes.${params.style.palette.name}`),
      }),
    },
  ]
  return items
}

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
          await http.post<{ id: string }>('/gis/layers', {
            name: analysis.name,
            spaceId: analysis.spaceId,
            datasetId,
            style: choroplethLayerStyle(params),
          })
        ).id
      void client.invalidateQueries({ queryKey: gisKeys.datasetLayers(datasetId) })
      const map = await http.post<{ id: string }>('/gis/maps', {
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
