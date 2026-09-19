import {
  type AnalysisRecord,
  type DatasetRecord,
  SPATIAL_OPS,
  type SpatialOp,
  TERRITORY_LEVELS,
  type TerritoryLevel,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { TerritorySelect } from '~/features/gis/territory-select.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { analysisStep, NEGATABLE, TARGET_OPS } from './analysis-step.js'
import { datasetQuery } from './queries.js'

const NONE = '__none'

type TargetKind = 'dataset' | 'territory'

/**
 * Запуск пространственного анализа с экрана датасета (07-gis-engine.md §10,
 * ADR-0069): операция, её параметры и цель → объект «анализ»; задание
 * материализует результат в новый датасет с правами пользователя.
 */
export function AnalysisDialog({
  dataset,
  onClose,
}: {
  dataset: DatasetRecord
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const labelOf = (item: DatasetRecord['fields'][number]) =>
    item.label[locale] ?? item.label.ru ?? item.key
  const geometries = dataset.fields.filter((field) => field.type === 'geometry')
  const attributes = dataset.fields.filter((field) => field.type !== 'geometry')

  const [op, setOp] = useState<SpatialOp>('buffer')
  const [field, setField] = useState(geometries[0]?.key ?? '')
  const [distance, setDistance] = useState('500')
  const [size, setSize] = useState('1000')
  const [limit, setLimit] = useState('1')
  const [maxDistance, setMaxDistance] = useState('')
  const [inside, setInside] = useState(false)
  const [negate, setNegate] = useState(false)
  const [level, setLevel] = useState<TerritoryLevel>('district')
  const [by, setBy] = useState(NONE)
  const [targetKind, setTargetKind] = useState<TargetKind>('dataset')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [territoryId, setTerritoryId] = useState<string | null>(null)
  const [targetLevel, setTargetLevel] = useState<string>(NONE)
  const [name, setName] = useState<string | null>(null)
  const [outputName, setOutputName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const needsTarget = TARGET_OPS.has(op)
  const { data: datasets } = useQuery({
    ...objectListQuery({ types: 'dataset', limit: 100 }),
    enabled: needsTarget && targetKind === 'dataset',
  })
  const { data: target } = useQuery({
    ...datasetQuery(targetId ?? ''),
    enabled: needsTarget && targetKind === 'dataset' && targetId !== null,
  })
  const targetGeometry = target?.fields.some((item) => item.type === 'geometry') ?? false

  const defaultName = `${t(`data.analysis.ops.${op}`)} — ${dataset.name}`
  const title = (name ?? defaultName).trim()

  const step = analysisStep({
    op,
    field: geometries.length > 1 ? field : null,
    distance,
    size,
    limit,
    maxDistance,
    inside,
    negate,
    level,
    by: by === NONE ? null : by,
    target:
      targetKind === 'dataset'
        ? { kind: 'dataset', id: targetId, hasGeometry: targetGeometry }
        : {
            kind: 'territory',
            id: territoryId,
            level: targetLevel === NONE ? null : (targetLevel as TerritoryLevel),
          },
  })
  const ready = Boolean(title) && step !== null

  const create = useMutation({
    mutationFn: () =>
      http.post<AnalysisRecord>('/analyses', {
        name: title,
        spaceId: dataset.spaceId,
        ...(outputName.trim() ? { outputName: outputName.trim() } : {}),
        query: {
          version: 1,
          source: { kind: 'dataset', id: dataset.id },
          steps: step ? [step] : [],
        },
        run: true,
      }),
    onSuccess: (record) => {
      toast.show({ title: t('data.analysis.started'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['objects'] })
      onClose()
      openTab({
        kind: 'object',
        objectId: record.id,
        objectType: 'analysis',
        title: record.name,
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const numeric = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    hint?: string,
  ) => (
    <Field label={label} {...(hint ? { hint } : {})}>
      <Input
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
      />
    </Field>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.analysis.title', { name: dataset.name })}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('data.analysis.start')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('data.analysis.operation')} hint={t(`data.analysis.opHints.${op}`)}>
            <Select
              value={op}
              onValueChange={(value) => {
                setOp(value as SpatialOp)
                setFailure(null)
              }}
            >
              <SelectTrigger aria-label={t('data.analysis.operation')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPATIAL_OPS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`data.analysis.ops.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {geometries.length > 1 ? (
            <Field label={t('data.analysis.geometryField')}>
              <Select value={field} onValueChange={setField}>
                <SelectTrigger aria-label={t('data.analysis.geometryField')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {geometries.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {labelOf(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {op === 'buffer' || op === 'dwithin'
            ? numeric(t('data.analysis.distance'), distance, setDistance)
            : null}
          {op === 'grid' || op === 'hexgrid'
            ? numeric(t('data.analysis.size'), size, setSize)
            : null}
          {op === 'nearest' ? (
            <div className="grid grid-cols-2 gap-3">
              {numeric(t('data.analysis.limit'), limit, setLimit)}
              {numeric(
                t('data.analysis.maxDistance'),
                maxDistance,
                setMaxDistance,
                t('data.analysis.maxDistanceHint'),
              )}
            </div>
          ) : null}
          {op === 'centroid' ? (
            <Checkbox
              checked={inside}
              onCheckedChange={(value) => setInside(value === true)}
              label={t('data.analysis.inside')}
            />
          ) : null}
          {op === 'assign_territory' ? (
            <Field label={t('data.analysis.level')}>
              <Select value={level} onValueChange={(value) => setLevel(value as TerritoryLevel)}>
                <SelectTrigger aria-label={t('data.analysis.level')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TERRITORY_LEVELS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`gis.territories.levels.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {op === 'dissolve' ? (
            <Field label={t('data.analysis.dissolveBy')}>
              <Select value={by} onValueChange={setBy}>
                <SelectTrigger aria-label={t('data.analysis.dissolveBy')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('data.analysis.dissolveAll')}</SelectItem>
                  {attributes.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {labelOf(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {needsTarget ? (
            <fieldset className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
              <legend className="px-1 text-xs font-medium text-fg-secondary">
                {t('data.analysis.target')}
              </legend>
              <SegmentedControl
                value={targetKind}
                onValueChange={(value) => setTargetKind(value as TargetKind)}
                options={(['dataset', 'territory'] as const).map((value) => ({
                  value,
                  label: t(`data.analysis.targetKinds.${value}`),
                }))}
                aria-label={t('data.analysis.target')}
              />
              {targetKind === 'dataset' ? (
                <Field label={t('data.analysis.targetDataset')}>
                  <Select value={targetId ?? ''} onValueChange={setTargetId}>
                    <SelectTrigger aria-label={t('data.analysis.targetDataset')}>
                      <SelectValue placeholder={t('data.analysis.chooseDataset')} />
                    </SelectTrigger>
                    <SelectContent>
                      {(datasets?.items ?? []).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : (
                <div className="flex flex-col gap-3">
                  <Field label={t('data.analysis.targetTerritory')}>
                    <TerritorySelect
                      value={territoryId ? { id: territoryId } : null}
                      onChange={(value) => setTerritoryId(value?.id ?? null)}
                      label={t('data.analysis.targetTerritory')}
                    />
                  </Field>
                  {territoryId ? null : (
                    <Field label={t('data.analysis.targetLevel')}>
                      <Select value={targetLevel} onValueChange={setTargetLevel}>
                        <SelectTrigger aria-label={t('data.analysis.targetLevel')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t('data.analysis.anyLevel')}</SelectItem>
                          {TERRITORY_LEVELS.map((value) => (
                            <SelectItem key={value} value={value}>
                              {t(`gis.territories.levels.${value}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </div>
              )}
              {targetKind === 'dataset' && target && !targetGeometry ? (
                <Callout tone="warning">{t('data.analysis.noTargetGeometry')}</Callout>
              ) : null}
              {NEGATABLE.has(op) ? (
                <Checkbox
                  checked={negate}
                  onCheckedChange={(value) => setNegate(value === true)}
                  label={t('data.analysis.negate')}
                />
              ) : null}
            </fieldset>
          ) : null}

          <Field label={t('data.analysis.name')}>
            <Input
              value={name ?? defaultName}
              onChange={(event) => setName(event.target.value)}
              aria-label={t('data.analysis.name')}
            />
          </Field>
          <Field label={t('data.analysis.outputName')} hint={t('data.analysis.outputHint')}>
            <Input
              value={outputName}
              placeholder={title}
              onChange={(event) => setOutputName(event.target.value)}
              aria-label={t('data.analysis.outputName')}
            />
          </Field>
          <p className="text-xs text-fg-muted">{t('data.analysis.policyNote')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
