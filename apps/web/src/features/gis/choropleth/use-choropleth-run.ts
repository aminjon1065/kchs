import {
  type AnalysisRecord,
  ChoroplethParams,
  type ChoroplethParamsInput,
  choroplethLayerStyle,
  type JobRecord,
  type MapLayerEntry,
  type MapRecord,
} from '@kchs/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, http } from '~/shared/api/client.js'
import { gisKeys } from '../queries.js'

/** Куда поставить слой хороплета. */
export type ChoroplethTarget =
  | { kind: 'current'; addLayer: (layerId: string) => void }
  | { kind: 'new'; name: string }
  | { kind: 'existing'; mapId: string }
  | { kind: 'none' }

export interface ChoroplethRunInput {
  params: ChoroplethParamsInput
  spaceId: string
  analysisName: string
  outputName: string
  layerName: string
  target: ChoroplethTarget
}

export type ChoroplethRunState =
  | { phase: 'idle' }
  | { phase: 'analysis'; analysisId: string; progress: number | null }
  | { phase: 'layer'; analysisId: string }
  | { phase: 'done'; analysisId: string; layerId: string; mapId: string | null }
  | { phase: 'failed'; analysisId: string | null; message: string }

/** Опрос анализа, пока задание в очереди или выполняется. */
const POLL_MS = 1500

const entry = (layerId: string): MapLayerEntry => ({
  layerId,
  visible: true,
  opacity: 1,
  group: null,
})

/**
 * Запуск хороплета (ADR-0077): анализ `choropleth` с запуском → ожидание
 * результата → слой с градуированным стилем по датасету-результату → карта
 * (текущая в студии, новая или существующая). Закрытый мастер опрос прекращает:
 * анализ досчитается, слой из результата делает карточка анализа.
 */
export function useChoroplethRun() {
  const client = useQueryClient()
  const [state, setState] = useState<ChoroplethRunState>({ phase: 'idle' })
  const alive = useRef(true)
  // Строгий режим React монтирует дважды: признак жизни восстанавливается при каждом монтировании
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const start = useCallback(
    async (input: ChoroplethRunInput) => {
      let analysisId: string | null = null
      const update = (next: ChoroplethRunState) => {
        if (alive.current) setState(next)
      }
      try {
        const created = await http.post<AnalysisRecord>('/analyses', {
          name: input.analysisName,
          spaceId: input.spaceId,
          outputName: input.outputName,
          choropleth: input.params,
          run: true,
        })
        analysisId = created.id
        void client.invalidateQueries({ queryKey: ['objects'] })
        let record = created
        update({ phase: 'analysis', analysisId, progress: null })
        while (
          record.status === 'queued' ||
          record.status === 'running' ||
          record.status === 'draft'
        ) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
          if (!alive.current) return
          record = await http.get<AnalysisRecord>(`/analyses/${analysisId}`)
          const job = record.jobId
            ? await http.get<JobRecord>(`/jobs/${record.jobId}`).catch(() => null)
            : null
          update({ phase: 'analysis', analysisId, progress: job?.progress ?? null })
        }
        if (record.status !== 'succeeded' || !record.outputDatasetId) {
          update({ phase: 'failed', analysisId, message: record.error ?? '' })
          return
        }

        update({ phase: 'layer', analysisId })
        const style = choroplethLayerStyle(ChoroplethParams.parse(input.params))
        const layer = await http.post<{ id: string }>('/gis/layers', {
          name: input.layerName,
          spaceId: input.spaceId,
          datasetId: record.outputDatasetId,
          style,
        })
        let mapId: string | null = null
        const target = input.target
        if (target.kind === 'current') {
          target.addLayer(layer.id)
        } else if (target.kind === 'new') {
          mapId = (
            await http.post<{ id: string }>('/gis/maps', {
              name: target.name,
              spaceId: input.spaceId,
              spec: { layers: [entry(layer.id)] },
            })
          ).id
        } else if (target.kind === 'existing') {
          const map = await http.get<MapRecord>(`/gis/maps/${target.mapId}`)
          await http.patch(`/gis/maps/${target.mapId}`, {
            spec: { ...map.spec, layers: [...map.spec.layers, entry(layer.id)] },
          })
          mapId = target.mapId
          void client.invalidateQueries({ queryKey: gisKeys.map(target.mapId) })
        }
        void client.invalidateQueries({ queryKey: ['objects'] })
        update({ phase: 'done', analysisId, layerId: layer.id, mapId })
      } catch (error) {
        update({
          phase: 'failed',
          analysisId,
          message: error instanceof ApiError ? error.message : '',
        })
      }
    },
    [client],
  )

  return { state, start }
}
