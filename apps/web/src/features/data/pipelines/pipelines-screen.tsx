import type { PipelineListItem } from '@kchs/contracts'
import { formatDateTime, formatNumber } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  PanelToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Workflow } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError } from '~/shared/api/client.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'
import { pipelineApi, pipelineKeys, pipelinesQuery } from './queries.js'

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

/**
 * Экран «Пайплайны» (06-analytics-engine.md §16, ADR-0106): список
 * преобразований, видимых сотруднику, и создание нового поверх датасета.
 * Сам конструктор открывается вкладкой объекта.
 */
export function PipelinesScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(pipelinesQuery())
  const items = data?.items ?? []
  const [creating, setCreating] = useState(false)

  const open = (pipeline: PipelineListItem) =>
    openTab({
      kind: 'object',
      objectId: pipeline.id,
      objectType: 'pipeline',
      title: pipeline.name,
      icon: 'pipeline',
      mode: 'permanent',
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('data.pipelines.title')}</h1>}
        right={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() => setCreating(true)}
          >
            {t('data.pipelines.create')}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          <Card padded={false}>
            {isLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-12 w-full" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={<Workflow />}
                title={t('data.pipelines.empty')}
                description={t('data.pipelines.emptyHint')}
              />
            ) : (
              <ul className="divide-y divide-line">
                {items.map((pipeline) => (
                  <li key={pipeline.id}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-hover"
                      onClick={() => open(pipeline)}
                    >
                      <Workflow className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-fg">{pipeline.name}</span>
                          <Badge
                            size="sm"
                            dot
                            tone={
                              pipeline.status === 'succeeded'
                                ? 'success'
                                : pipeline.status === 'failed'
                                  ? 'danger'
                                  : 'neutral'
                            }
                          >
                            {t(`data.pipelines.status.${pipeline.status}`)}
                          </Badge>
                          {pipeline.schedule ? (
                            <Badge tone="neutral" size="sm">
                              {pipeline.schedule}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="tabular mt-1 block text-xs text-fg-secondary">
                          {[
                            pipeline.rowCount === null
                              ? null
                              : t('data.pipelines.rows', {
                                  rows: formatNumber(pipeline.rowCount, {}, { locale }),
                                }),
                            pipeline.lastRunAt
                              ? t('data.pipelines.lastRun', {
                                  at: formatDateTime(pipeline.lastRunAt, { locale }),
                                })
                              : t('data.pipelines.neverRun'),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <CreatePipelineDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id, name) => {
          openTab({
            kind: 'object',
            objectId: id,
            objectType: 'pipeline',
            title: name,
            icon: 'pipeline',
            mode: 'permanent',
          })
        }}
      />
    </div>
  )
}

/** Новый пайплайн: название, пространство и входной датасет. */
function CreatePipelineDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string, name: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const { data: spaces = [] } = useQuery(spacesQuery())
  const { data: datasets } = useQuery(objectListQuery({ types: 'dataset', limit: 100 }))
  const available = orderSpaces(spaces)
  const [name, setName] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [datasetId, setDatasetId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const target = spaceId || available[0]?.id || ''

  const create = useMutation({
    mutationFn: () =>
      pipelineApi.create({
        name: name.trim(),
        spaceId: target,
        runOnImport: false,
        enabled: true,
        definition: {
          version: 1,
          source: { kind: 'dataset', id: datasetId },
          steps: [],
          outputName: t('data.pipelines.defaultOutput', { name: name.trim() }),
        },
      }),
    onSuccess: async (record) => {
      toast.show({ title: t('data.pipelines.created'), tone: 'success' })
      await client.invalidateQueries({ queryKey: pipelineKeys.all })
      onCreated(record.id, record.name)
      onOpenChange(false)
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const valid = name.trim().length > 0 && target.length > 0 && datasetId.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('data.pipelines.create')}
        description={t('data.pipelines.createHint')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!valid}
              loading={create.isPending}
            >
              {t('data.pipelines.create')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) create.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('data.pipelines.fields.name')} htmlFor={`${formId}-name`} required>
            <Input
              id={`${formId}-name`}
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('data.pipelines.fields.space')} htmlFor={`${formId}-space`} required>
            <Select value={target} onValueChange={setSpaceId}>
              <SelectTrigger id={`${formId}-space`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {available.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('data.pipelines.fields.source')} htmlFor={`${formId}-dataset`} required>
            <Select value={datasetId} onValueChange={setDatasetId}>
              <SelectTrigger id={`${formId}-dataset`}>
                <SelectValue placeholder={t('data.pipelines.fields.sourcePlaceholder')} />
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
        </form>
      </DialogContent>
    </Dialog>
  )
}
