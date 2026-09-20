import type {
  PipelineDefinition,
  PipelineStep,
  PipelineStepType,
  QueryResult,
} from '@kchs/contracts'
import { PIPELINE_STEP_TYPES } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Input,
  PanelToolbar,
  SectionHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Play, Plus, Save, Trash2, Workflow } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { pipelineApi, pipelineKeys, pipelineQuery, pipelineRunsQuery } from './queries.js'
import { StepEditor } from './step-editor.js'
import { describeStep, emptyStep } from './step-model.js'

const PREVIEW_ROWS = 50

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

/** Новый идентификатор шага: короткий и устойчивый к повторам. */
const nextStepId = (steps: PipelineStep[]): string => {
  const taken = new Set(steps.map((step) => step.id))
  for (let index = 1; ; index++) {
    const id = `s${index}`
    if (!taken.has(id)) return id
  }
}

/**
 * Конструктор пайплайна (06-analytics-engine.md §16, ADR-0106): цепочка шагов
 * слева, форма выбранного шага справа, предпросмотр результата шага на выборке
 * и журнал прогонов. Проверка определения идёт на сервере: он один знает схемы
 * датасетов и права смотрящего.
 */
export default function PipelineDesigner({ pipelineId }: { pipelineId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const { data: pipeline, isLoading } = useQuery(pipelineQuery(pipelineId))
  const { data: runsData } = useQuery(pipelineRunsQuery(pipelineId))
  const [draft, setDraft] = useState<PipelineDefinition | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [issue, setIssue] = useState<{ stepId: string | null; message: string } | null>(null)
  const [preview, setPreview] = useState<QueryResult | null>(null)
  const [schedule, setSchedule] = useState('')
  const [runOnImport, setRunOnImport] = useState(false)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (pipeline && !draft) {
      setDraft(pipeline.definition)
      setSchedule(pipeline.schedule ?? '')
      setRunOnImport(pipeline.runOnImport)
      setEnabled(pipeline.enabled)
      setSelected(pipeline.definition.steps[0]?.id ?? null)
    }
  }, [pipeline, draft])

  const validate = useMutation({
    mutationFn: (definition: PipelineDefinition) => pipelineApi.validate(definition),
    onSuccess: (result) =>
      setIssue(result.ok ? null : { stepId: result.stepId, message: result.message ?? '' }),
    // Незаполненный шаг сервер не принимает: показываем причину и не даём сохранить
    onError: (err) => setIssue({ stepId: null, message: problemMessage(err, t('errors.unknown')) }),
  })

  const runPreview = useMutation({
    mutationFn: () =>
      pipelineApi.preview(draft as PipelineDefinition, selected ?? undefined, PREVIEW_ROWS),
    onSuccess: (result) => setPreview(result),
    onError: (err) => toast.error(problemMessage(err, t('errors.unknown'))),
  })

  const save = useMutation({
    mutationFn: () =>
      pipelineApi.update(pipelineId, {
        definition: draft as PipelineDefinition,
        schedule: schedule.trim() || null,
        runOnImport,
        enabled,
      }),
    onSuccess: async () => {
      toast.show({ title: t('data.pipelines.saved'), tone: 'success' })
      await client.invalidateQueries({ queryKey: pipelineKeys.all })
    },
    onError: (err) => toast.error(problemMessage(err, t('errors.unknown'))),
  })

  const run = useMutation({
    mutationFn: () => pipelineApi.run(pipelineId),
    onSuccess: async () => {
      toast.show({ title: t('data.pipelines.runStarted'), tone: 'success' })
      await client.invalidateQueries({ queryKey: pipelineKeys.all })
    },
    onError: (err) => toast.error(problemMessage(err, t('errors.unknown'))),
  })

  if (isLoading || !pipeline || !draft) return <Skeleton className="m-6 h-64" />

  const update = (next: PipelineDefinition) => {
    setDraft(next)
    validate.mutate(next)
  }
  const setSteps = (steps: PipelineStep[]) => update({ ...draft, steps })
  const current = draft.steps.find((step) => step.id === selected) ?? null

  const addStep = (type: PipelineStepType) => {
    const step = emptyStep(type, nextStepId(draft.steps))
    setSteps([...draft.steps, step])
    setSelected(step.id)
  }

  const move = (index: number, delta: number) => {
    const next = [...draft.steps]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [item] = next.splice(index, 1)
    if (item) next.splice(target, 0, item)
    setSteps(next)
  }

  const runs = runsData?.items ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <div className="flex items-center gap-2">
            <Workflow className="size-4 text-fg-muted" aria-hidden />
            <h1 className="truncate text-sm font-semibold text-fg">{pipeline.name}</h1>
            <Badge tone={enabled ? 'success' : 'neutral'} size="sm">
              {enabled ? t('data.pipelines.enabled') : t('data.pipelines.disabled')}
            </Badge>
            {pipeline.status !== 'draft' ? (
              <Badge
                size="sm"
                dot
                tone={
                  pipeline.status === 'succeeded'
                    ? 'success'
                    : pipeline.status === 'failed'
                      ? 'danger'
                      : 'accent'
                }
              >
                {t(`data.pipelines.status.${pipeline.status}`)}
              </Badge>
            ) : null}
          </div>
        }
        right={
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              aria-label={t('data.pipelines.fields.enabled')}
              disabled={!pipeline.canManage}
              onCheckedChange={setEnabled}
            />
            <Button
              variant="secondary"
              size="sm"
              icon={<Play className="size-3.5" />}
              disabled={!pipeline.canManage || issue !== null}
              loading={run.isPending}
              onClick={() => run.mutate()}
            >
              {t('data.pipelines.run')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Save className="size-3.5" />}
              disabled={!pipeline.canManage || issue !== null}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          {issue ? (
            <Callout tone="danger">
              {issue.stepId
                ? t('data.pipelines.stepIssue', { step: issue.stepId, message: issue.message })
                : issue.message}
            </Callout>
          ) : null}

          <section className="flex flex-col gap-3">
            <SectionHeader
              title={t('data.pipelines.steps')}
              action={
                <Select value="" onValueChange={(value) => addStep(value as PipelineStepType)}>
                  <SelectTrigger aria-label={t('data.pipelines.addStep')} className="w-56">
                    <SelectValue placeholder={t('data.pipelines.addStep')} />
                  </SelectTrigger>
                  <SelectContent>
                    {PIPELINE_STEP_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`data.pipelines.stepTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <Card padded={false}>
              {draft.steps.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Plus />}
                  title={t('data.pipelines.noSteps')}
                  description={t('data.pipelines.noStepsHint')}
                />
              ) : (
                <ul className="divide-y divide-line">
                  {draft.steps.map((step, index) => (
                    <li
                      key={step.id}
                      className={`flex items-center gap-2 px-3 py-2 ${
                        step.id === selected ? 'bg-surface-hover' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setSelected(step.id)}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-fg-muted">{index + 1}</span>
                          <span className="font-medium text-fg">
                            {t(`data.pipelines.stepTypes.${step.type}`)}
                          </span>
                          {step.disabled ? (
                            <Badge tone="neutral" size="sm">
                              {t('data.pipelines.stepDisabled')}
                            </Badge>
                          ) : null}
                          {issue?.stepId === step.id ? (
                            <Badge tone="danger" size="sm" dot>
                              {t('data.pipelines.stepError')}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-fg-secondary">
                          {describeStep(step)}
                        </span>
                      </button>
                      <IconButton
                        size="sm"
                        label={t('data.pipelines.moveUp')}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={t('data.pipelines.moveDown')}
                        disabled={index === draft.steps.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown className="size-4" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={t('data.pipelines.removeStep')}
                        onClick={() => {
                          setSteps(draft.steps.filter((item) => item.id !== step.id))
                          if (selected === step.id) setSelected(null)
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          {current ? (
            <section className="flex flex-col gap-3">
              <SectionHeader
                title={t('data.pipelines.stepSettings', {
                  type: t(`data.pipelines.stepTypes.${current.type}`),
                })}
              />
              <Card className="flex flex-col gap-3 p-4">
                <StepEditor
                  step={current}
                  onChange={(next) =>
                    setSteps(draft.steps.map((step) => (step.id === current.id ? next : step)))
                  }
                />
                <Checkbox
                  label={t('data.pipelines.fields.stepDisabled')}
                  checked={current.disabled}
                  onCheckedChange={(checked) =>
                    setSteps(
                      draft.steps.map((step) =>
                        step.id === current.id ? { ...step, disabled: checked === true } : step,
                      ),
                    )
                  }
                />
              </Card>
            </section>
          ) : null}

          <Tabs defaultValue="preview">
            <TabsList>
              <TabsTrigger value="preview">{t('data.pipelines.preview')}</TabsTrigger>
              <TabsTrigger value="runs">{t('data.pipelines.runs')}</TabsTrigger>
              <TabsTrigger value="settings">{t('data.pipelines.settings')}</TabsTrigger>
            </TabsList>
            <TabsContent value="preview">
              <div className="flex flex-col gap-3 pt-3">
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={runPreview.isPending}
                    onClick={() => runPreview.mutate()}
                  >
                    {t('data.pipelines.showPreview')}
                  </Button>
                </div>
                {preview ? <PreviewTable result={preview} /> : null}
              </div>
            </TabsContent>
            <TabsContent value="runs">
              <div className="flex flex-col gap-2 pt-3">
                {runs.length === 0 ? (
                  <EmptyState compact icon={<Play />} title={t('data.pipelines.runsEmpty')} />
                ) : (
                  runs.map((item) => (
                    <div key={item.id} className="rounded-md border border-line px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          size="sm"
                          dot
                          tone={
                            item.status === 'succeeded'
                              ? 'success'
                              : item.status === 'failed'
                                ? 'danger'
                                : 'accent'
                          }
                        >
                          {t(`data.pipelines.runStatus.${item.status}`)}
                        </Badge>
                        <span className="tabular text-xs text-fg-secondary">
                          {formatDateTime(item.startedAt, { locale })}
                        </span>
                        <span className="text-xs text-fg-muted">
                          {t(`data.pipelines.triggers.${item.trigger}`)}
                        </span>
                      </div>
                      {item.error ? (
                        <p className="mt-1 text-xs text-danger-fg">{item.error}</p>
                      ) : (
                        <p className="tabular mt-1 text-xs text-fg-secondary">
                          {t('data.pipelines.runStats', {
                            rows: String(item.stats.rows ?? 0),
                            version: String(item.stats.version ?? '—'),
                          })}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </TabsContent>
            <TabsContent value="settings">
              <Card className="mt-3 flex flex-col gap-3 p-4">
                <Field
                  label={t('data.pipelines.fields.outputName')}
                  htmlFor={`${nameId}-output`}
                  hint={t('data.pipelines.fields.outputHint')}
                >
                  <Input
                    id={`${nameId}-output`}
                    value={draft.outputName}
                    onChange={(event) => update({ ...draft, outputName: event.target.value })}
                  />
                </Field>
                <Field
                  label={t('data.pipelines.fields.schedule')}
                  htmlFor={`${nameId}-cron`}
                  hint={t('data.pipelines.fields.scheduleHint')}
                >
                  <Input
                    id={`${nameId}-cron`}
                    className="font-mono"
                    placeholder="0 6 * * *"
                    value={schedule}
                    onChange={(event) => setSchedule(event.target.value)}
                  />
                </Field>
                <Checkbox
                  label={t('data.pipelines.fields.runOnImport')}
                  checked={runOnImport}
                  onCheckedChange={(checked) => setRunOnImport(checked === true)}
                />
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}

/** Результат предпросмотра шага: первые строки с заголовками полей. */
function PreviewTable({ result }: { result: QueryResult }) {
  const t = useT()
  if (result.fields.length === 0) {
    return <EmptyState compact icon={<Workflow />} title={t('data.pipelines.previewEmpty')} />
  }
  return (
    <Card padded={false}>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr>
              {result.fields.map((field) => (
                <th
                  key={field.name}
                  className="border-line border-b px-3 py-2 text-left font-medium text-fg-secondary"
                >
                  {field.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              // Порядок строк и столбцов задан результатом запроса и не меняется
              <tr key={`row-${index}`} className="border-line border-b last:border-0">
                {row.map((value, column) => (
                  <td key={`cell-${column}`} className="tabular px-3 py-1.5 text-fg">
                    {value === null || value === undefined ? '' : String(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
