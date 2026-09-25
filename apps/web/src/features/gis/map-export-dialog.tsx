import type {
  DatasetExportDownload,
  DatasetExportInput,
  DatasetExportResult,
  DatasetExportStarted,
  LayerRecord,
} from '@kchs/contracts'
import { Button, Callout, Dialog, DialogContent, SegmentedControl, Spinner } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { exportJobQuery, isJobFinished } from '~/features/data/queries.js'
import { ApiError, http } from '~/shared/api/client.js'

/** Геоформаты выгрузки карты: GeoJSON пишет воркер, GeoPackage и KML — движок (ADR-0068). */
const FORMATS = ['geojson', 'gpkg', 'kml'] as const
type MapExportFormat = (typeof FORMATS)[number]

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/** Строка слоя: ход задания экспорта его датасета и «Скачать». */
function LayerExport({ layer, jobId }: { layer: LayerRecord; jobId: string | null }) {
  const t = useT()
  const [failure, setFailure] = useState<string | null>(null)
  const { data: job } = useQuery({ ...exportJobQuery(jobId ?? ''), enabled: jobId !== null })
  const result = job?.status === 'succeeded' ? (job.result as DatasetExportResult | null) : null
  const failed = job !== undefined && isJobFinished(job.status) && job.status !== 'succeeded'
  const download = useMutation({
    mutationFn: () => http.get<DatasetExportDownload>(`/datasets/exports/${jobId}/download`),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{layer.name}</span>
      {failure || failed ? (
        <span className="text-xs text-danger">
          {failure ??
            (typeof job?.error?.message === 'string' ? job.error.message : t('data.export.failed'))}
        </span>
      ) : result ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<Download className="size-3.5" />}
          loading={download.isPending}
          onClick={() => download.mutate()}
          aria-label={t('gis.map.export.downloadLayer', { name: layer.name })}
        >
          {t('data.export.download')}
        </Button>
      ) : jobId ? (
        <Spinner className="size-4" />
      ) : null}
    </li>
  )
}

/**
 * Выгрузка карты в геоформаты (ADR-0160): видимые слои с доступом к данным —
 * по файлу на слой, заданием экспорта его датасета с фильтром слоя и
 * политиками пользователя (ADR-0056); нужна способность «Выгрузка данных».
 */
export function MapExportDialog({
  layers,
  onClose,
}: {
  layers: readonly LayerRecord[]
  onClose: () => void
}) {
  const t = useT()
  const [format, setFormat] = useState<MapExportFormat>('geojson')
  const [jobs, setJobs] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const start = useMutation({
    mutationFn: async () => {
      const started: Record<string, string> = {}
      for (const layer of layers) {
        const body: DatasetExportInput = {
          format,
          sort: [],
          ...(layer.style.filter ? { where: layer.style.filter } : {}),
        }
        const { jobId } = await http.post<DatasetExportStarted>(
          `/datasets/${layer.datasetId}/exports`,
          body,
        )
        started[layer.id] = jobId
      }
      return started
    },
    onSuccess: (started) => {
      setFailure(null)
      setJobs(started)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })
  const running = Object.keys(jobs).length > 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.map.export.title')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {running ? t('common.actions.close') : t('common.actions.cancel')}
            </Button>
            {running ? null : (
              <Button
                variant="primary"
                disabled={layers.length === 0}
                loading={start.isPending}
                onClick={() => start.mutate()}
              >
                {t('data.export.start')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-fg-secondary">
              {t('data.export.format')}
            </legend>
            <SegmentedControl
              value={format}
              onValueChange={(value) => {
                setFormat(value)
                setJobs({})
              }}
              options={FORMATS.map((value) => ({
                value,
                label: t(`data.export.formats.${value}`),
              }))}
              aria-label={t('data.export.geoFormats')}
            />
            <p className="text-xs text-fg-muted">{t(`data.export.formatHints.${format}`)}</p>
          </fieldset>
          {layers.length === 0 ? (
            <Callout tone="info">{t('gis.map.export.noLayers')}</Callout>
          ) : (
            <ul aria-label={t('gis.map.export.layers')} className="flex flex-col gap-1.5">
              {layers.map((layer) => (
                <LayerExport key={layer.id} layer={layer} jobId={jobs[layer.id] ?? null} />
              ))}
            </ul>
          )}
          <p className="text-xs text-fg-muted">{t('gis.map.export.hint')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
