import type { ObjectSummary } from '@kchs/contracts'
import {
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Input,
  ObjectIcon,
  RadioGroup,
  RadioItem,
  Skeleton,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { datasetQuery } from '../data/queries.js'
import { datasetLayersQuery, gisKeys } from './queries.js'

const NEW = 'new'

/**
 * «Добавить слой» на карту (P2-E02 S01): датасет с геометрией → его слой
 * или новый слой со стилем по умолчанию (ADR-0064). Слой создаётся в
 * пространстве карты; данные видны с политиками каждого смотрящего.
 */
export function AddLayerDialog({
  spaceId,
  present,
  onAdd,
  onClose,
}: {
  spaceId: string
  /** Слои, уже стоящие на карте, — повторно не предлагаются. */
  present: ReadonlySet<string>
  onAdd: (layerId: string) => void
  onClose: () => void
}) {
  const t = useT()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [choice, setChoice] = useState<string>(NEW)
  const [failure, setFailure] = useState<string | null>(null)

  const datasets = useQuery(
    objectListQuery({ types: 'dataset', q: search.trim() || undefined, limit: 50 }),
  )
  const dataset = useQuery({ ...datasetQuery(datasetId ?? ''), enabled: datasetId !== null })
  const layers = useQuery({
    ...datasetLayersQuery(datasetId ?? ''),
    enabled: datasetId !== null,
  })
  const geometryFields = (dataset.data?.fields ?? []).filter((field) => field.type === 'geometry')
  const available = (layers.data ?? []).filter((layer) => !present.has(layer.id))

  const add = useMutation({
    mutationFn: async () => {
      if (!dataset.data) throw new Error('no dataset')
      if (choice !== NEW) return choice
      const created = await http.post<{ id: string }>('/gis/layers', {
        name: dataset.data.name,
        spaceId,
        datasetId: dataset.data.id,
      })
      void client.invalidateQueries({ queryKey: gisKeys.datasetLayers(dataset.data.id) })
      return created.id
    },
    onSuccess: (layerId) => {
      onAdd(layerId)
      onClose()
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const pick = (item: ObjectSummary) => {
    setDatasetId(item.id)
    setChoice(NEW)
    setFailure(null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.map.addLayerTitle')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!dataset.data || geometryFields.length === 0}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              {t('gis.map.addLayer')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('gis.map.findDataset')}
            aria-label={t('gis.map.findDataset')}
            prefix={<Search className="size-4" />}
          />
          <ul
            className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-line"
            aria-label={t('gis.map.datasets')}
          >
            {datasets.isLoading ? (
              <li className="p-2">
                <Skeleton className="h-6 w-full" />
              </li>
            ) : (datasets.data?.items ?? []).length === 0 ? (
              <li>
                <EmptyState compact title={t('gis.map.noDatasets')} />
              </li>
            ) : (
              (datasets.data?.items ?? []).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => pick(item)}
                    aria-pressed={item.id === datasetId}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2',
                      item.id === datasetId && 'bg-accent-subtle text-accent',
                    )}
                  >
                    <ObjectIcon type="dataset" className="size-4 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {item.spaceName ? (
                      <span className="shrink-0 truncate text-xs text-fg-muted">
                        {item.spaceName}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
          {datasetId && dataset.data ? (
            geometryFields.length === 0 ? (
              <Callout tone="info">{t('gis.map.noGeometry')}</Callout>
            ) : (
              <RadioGroup value={choice} onValueChange={setChoice} className="flex flex-col gap-2">
                <RadioItem value={NEW} label={t('gis.map.newLayer', { name: dataset.data.name })} />
                {available.map((layer) => (
                  <RadioItem key={layer.id} value={layer.id} label={layer.name} />
                ))}
              </RadioGroup>
            )
          ) : datasetId ? (
            <Skeleton className="h-12 w-full" />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
