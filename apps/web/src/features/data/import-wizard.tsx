import {
  type DatasetRecord,
  IMPORT_LIMITS,
  type ImportAnalysis,
  type ImportMode,
  type ImportOptions,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  FileDropzone,
  ProgressBar,
  Sheet,
  SheetContent,
  Spinner,
  Stepper,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { uploadFile } from '~/entities/files/upload.js'
import { ApiError, http } from '~/shared/api/client.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import {
  buildRunInput,
  defaultDatasetName,
  type MappingRow,
  mappingProblems,
  needsCrs,
  optionsFrom,
  rowsFrom,
  supportsReview,
} from './import-mapping.js'
import { MappingStep } from './import-mapping-step.js'
import { ImportProgress, ReviewStep } from './import-review-step.js'
import { StructureStep } from './import-structure-step.js'
import { dataKeys } from './queries.js'

const STEPS = ['file', 'structure', 'mapping', 'review'] as const
const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.json,.ndjson,.geojson,.zip,.gpkg,.kml,.kmz,.gpx'

export interface ImportWizardProps {
  onClose: () => void
  /** Пространство нового датасета и загружаемого файла. */
  spaceId: string
  /** Файл, брошенный в каталог, — мастер сразу начинает с его загрузки. */
  initialFile?: File | null
  /** Импорт в существующий датасет (из его экрана). */
  dataset?: DatasetRecord
  /**
   * Новый датасет загружен — вместо «Открыть датасет» (файл сразу на карту,
   * ADR-0160: вызывающий создаёт слой). Подпись кнопки итога — `openLabel`.
   */
  onImported?: (datasetId: string, name: string) => void
  openLabel?: string
}

/**
 * Мастер импорта (03-screens.md §6): Файл → Структура → Сопоставление →
 * Проверка и запуск; затем ход выполнения и итог с кнопкой «Открыть».
 */
export function ImportWizard({
  onClose,
  spaceId,
  initialFile,
  dataset,
  onImported,
  openLabel,
}: ImportWizardProps) {
  const t = useT()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)

  const [step, setStep] = useState(0)
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null)
  const [options, setOptions] = useState<ImportOptions>({})
  const [rows, setRows] = useState<MappingRow[]>([])
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ImportMode>(dataset ? 'append' : 'replace')
  const [useGeometry, setUseGeometry] = useState(true)
  const [review, setReview] = useState(true)
  const [onError, setOnError] = useState<'skip' | 'stop'>('skip')
  const [importId, setImportId] = useState<string | null>(null)

  const analyze = useMutation({
    mutationFn: (input: { fileId: string; options: ImportOptions }) =>
      http.post('/datasets/imports/analyze', { body: input }),
    onSuccess: (result) => {
      setFailure(null)
      setAnalysis(result)
      setOptions(optionsFrom(result))
      setRows(rowsFrom(result, dataset))
      setStep((current) => Math.max(current, 1))
    },
    onError: (error) =>
      setFailure(error instanceof ApiError ? error.message : t('data.import.file.analyzeFailed')),
  })

  const takeFile = async (picked: File): Promise<void> => {
    if (picked.size > IMPORT_LIMITS.maxFileBytes) {
      setFailure(t('data.import.file.tooLarge'))
      return
    }
    setFailure(null)
    setProgress(0)
    try {
      const uploaded = await uploadFile({ file: picked, spaceId, onProgress: setProgress })
      setFile({ id: uploaded.id, name: picked.name })
      setName((current) => current || defaultDatasetName(picked.name))
      analyze.mutate({ fileId: uploaded.id, options: {} })
    } catch {
      setFailure(t('data.import.file.uploadFailed'))
    } finally {
      setProgress(null)
    }
  }

  // Файл из каталога загружается один раз, при открытии мастера
  const initialTaken = useRef(false)
  useEffect(() => {
    if (initialFile && !initialTaken.current) {
      initialTaken.current = true
      void takeFile(initialFile)
    }
  })

  const start = useMutation({
    mutationFn: () => {
      if (!file || !analysis) throw new Error(t('data.import.file.analyzeFailed'))
      return http.post('/datasets/imports', {
        body: buildRunInput({
          fileId: file.id,
          options,
          rows,
          target: { dataset, name, mode, spaceId },
          geometry: useGeometry ? analysis.geometry : null,
          onError,
          review,
        }),
      })
    },
    onSuccess: (record) => {
      setFailure(null)
      setImportId(record.id)
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const problems = useMemo(
    () => mappingProblems(rows, { dataset, name, mode }),
    [rows, dataset, name, mode],
  )

  const title = dataset
    ? t('data.import.titleInto', { name: dataset.name })
    : t('data.import.title')

  // Геометрия в метрах без системы координат не загрузится — сначала выбрать систему
  const canNext =
    (step === 0 && Boolean(analysis)) ||
    (step === 1 && Boolean(analysis) && !analyze.isPending && !(analysis && needsCrs(analysis))) ||
    (step === 2 && problems.length === 0)
  const reviewing = review && supportsReview({ dataset, mode })

  const footer = importId ? null : (
    <>
      {step > 0 ? (
        <Button variant="ghost" onClick={() => setStep(step - 1)} className="mr-auto">
          {t('data.import.back')}
        </Button>
      ) : null}
      <Button variant="secondary" onClick={onClose}>
        {t('common.actions.cancel')}
      </Button>
      {step < 3 ? (
        <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
          {t('data.import.next')}
        </Button>
      ) : (
        <Button
          variant="primary"
          loading={start.isPending}
          disabled={problems.length > 0}
          onClick={() => start.mutate()}
        >
          {t(reviewing ? 'data.import.review.startReview' : 'data.import.review.start')}
        </Button>
      )}
    </>
  )

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={title} width="min(960px, 100vw)" footer={footer}>
        {importId ? (
          <ImportProgress
            importId={importId}
            dataset={dataset}
            openLabel={openLabel}
            onOpen={(datasetId) => {
              if (onImported) {
                onImported(datasetId, dataset?.name ?? name)
                onClose()
                return
              }
              openTab({
                kind: 'object',
                objectId: datasetId,
                objectType: 'dataset',
                title: dataset?.name ?? name,
                mode: 'permanent',
              })
              onClose()
            }}
            onClose={onClose}
            onFinished={(record) => {
              void client.invalidateQueries({ queryKey: ['objects'] })
              void client.invalidateQueries({ queryKey: dataKeys.dataset(record.datasetId) })
            }}
          />
        ) : (
          <div className="flex flex-col gap-5">
            <Stepper
              aria-label={t('data.import.steps.label')}
              steps={STEPS.map((key, index) => ({
                key,
                label: t(`data.import.steps.${key}`),
                description: index === 0 && file ? file.name : undefined,
              }))}
              current={step}
              onStepClick={setStep}
            />
            {failure ? <Callout tone="danger">{failure}</Callout> : null}
            {step === 0 ? (
              <FileStep
                progress={progress}
                analyzing={analyze.isPending}
                fileName={file?.name}
                onFile={(picked) => void takeFile(picked)}
              />
            ) : null}
            {step === 1 && analysis ? (
              <StructureStep
                analysis={analysis}
                options={options}
                onOptionsChange={setOptions}
                analyzing={analyze.isPending}
                onApply={() => file && analyze.mutate({ fileId: file.id, options })}
              />
            ) : null}
            {step === 2 && analysis ? (
              <MappingStep
                analysis={analysis}
                rows={rows}
                onRowsChange={setRows}
                dataset={dataset}
                name={name}
                onNameChange={setName}
                mode={mode}
                onModeChange={setMode}
                useGeometry={useGeometry}
                onUseGeometryChange={setUseGeometry}
                review={review}
                onReviewChange={setReview}
                problems={problems}
              />
            ) : null}
            {step === 3 && analysis && file ? (
              <ReviewStep
                analysis={analysis}
                rows={rows}
                fileName={file.name}
                dataset={dataset}
                name={name}
                mode={mode}
                review={reviewing}
                onError={onError}
                onOnErrorChange={setOnError}
              />
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ─── Шаг 1. Файл ─────────────────────────────────────────────────────────────

function FileStep({
  progress,
  analyzing,
  fileName,
  onFile,
}: {
  progress: number | null
  analyzing: boolean
  fileName?: string
  onFile: (file: File) => void
}) {
  const t = useT()
  if (progress !== null) {
    return (
      <div className="flex flex-col gap-2 py-8">
        <span className="text-sm text-fg-secondary">
          {t('data.import.file.uploading', { name: fileName ?? '' })}
        </span>
        <ProgressBar value={progress} showValue />
      </div>
    )
  }
  if (analyzing) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-fg-secondary">
        <Spinner />
        {t('data.import.file.analyzing')}
      </div>
    )
  }
  return (
    <FileDropzone
      multiple={false}
      accept={ACCEPT}
      onFiles={(files) => files[0] && onFile(files[0])}
      label={t('data.catalog.emptyHint')}
      hint={t('data.catalog.formats')}
    />
  )
}
