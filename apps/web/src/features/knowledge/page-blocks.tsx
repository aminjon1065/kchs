import type { MetricValue, PageBlockKind, QueryResult } from '@kchs/contracts'
import {
  Badge,
  Button,
  Chart,
  IconButton,
  Input,
  NumberTile,
  RichTextEditor,
  Skeleton,
  Spinner,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Copy, MessageSquare, Trash2 } from 'lucide-react'
import type * as Y from 'yjs'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { DatasetTable } from '~/features/data/dataset-table.js'
import { metricTileModel } from '~/features/data/metric-format.js'
import { chartQuery, datasetQuery, metricQuery } from '~/features/data/queries.js'
import { FilePreview } from '~/features/files/file-preview.js'
import { MapEmbed } from '~/features/gis/map-embed.js'
import {
  applyTextChange,
  type CellMap,
  useCellValue,
  useYChanges,
  writeCell,
} from '~/features/notebooks/notebook-doc.js'
import { ObjectPicker } from '~/features/notebooks/object-picker.js'
import { tasksQuery } from '~/features/tasks/queries.js'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { usePageContext } from './page-context.js'
import { bodyFragment, captionText, embedKeyOf } from './page-doc.js'

const CHART_HEIGHT = 320
/** Задач в блоке-списке — не больше: страница остаётся страницей, а не экраном. */
const TASKS_LIMIT = 20

/** Значок вида блока: читатель сразу понимает, что перед ним. */
const TONE: Partial<Record<PageBlockKind, 'neutral' | 'accent' | 'outline'>> = {
  text: 'outline',
  table: 'outline',
}

/** Подпись блока — обычная строка JSON: её меняет последняя запись. */
function BlockTitle({ block, label }: { block: CellMap; label: string }) {
  const { readOnly } = usePageContext()
  const title = useCellValue<string | null>(block, 'title') ?? ''
  return (
    <Input
      value={title}
      onChange={(event) => writeCell(block, { title: event.target.value || null })}
      aria-label={label}
      placeholder={label}
      readOnly={readOnly}
      className="font-medium"
    />
  )
}

/** Выбор встроенного объекта: список пространства страницы, затем все доступные. */
function EmbedPicker({
  block,
  kind,
  type,
}: {
  block: CellMap
  kind: PageBlockKind
  type: 'dataset' | 'chart' | 'metric' | 'map' | 'layer' | 'file' | 'project'
}) {
  const t = useT()
  const { readOnly, spaceId } = usePageContext()
  const key = embedKeyOf(kind) as string
  const value = useCellValue<string | null>(block, key) ?? null
  return (
    <ObjectPicker
      type={type}
      value={value}
      spaceId={spaceId}
      disabled={readOnly}
      label={t(`knowledge.blocks.${kind}`)}
      placeholder={t(
        kind === 'file' || kind === 'image' ? 'knowledge.blocks.pickFile' : 'knowledge.blocks.pick',
      )}
      onChange={(id) => writeCell(block, { [key]: id })}
    />
  )
}

function NotPicked() {
  const t = useT()
  return (
    <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-muted">
      {t('knowledge.blocks.notPicked')}
    </p>
  )
}

/** График страницы: сохранённый график со своими данными (без параметров тетради). */
function ChartBlock({ block }: { block: CellMap }) {
  const { data: me } = useQuery(meQuery())
  const chartId = useCellValue<string | null>(block, 'chartId') ?? null
  const chart = useQuery({ ...chartQuery(chartId ?? ''), enabled: Boolean(chartId), retry: false })
  const data = useQuery({
    queryKey: ['object', chartId ?? '', 'page-chart'],
    queryFn: () => http.post<QueryResult>(`/charts/${chartId}/data`, {}),
    enabled: Boolean(chartId),
    retry: false,
  })
  if (!chartId) return <NotPicked />
  if (!chart.data || !data.data) return <Skeleton className="h-64" />
  return (
    <Chart
      spec={chart.data.spec}
      result={data.data}
      height={CHART_HEIGHT}
      timezone={me?.user.timezone}
    />
  )
}

function MetricBlock({ block }: { block: CellMap }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const metricId = useCellValue<string | null>(block, 'metricId') ?? null
  const metric = useQuery({
    ...metricQuery(metricId ?? ''),
    enabled: Boolean(metricId),
    retry: false,
  })
  const value = useQuery({
    queryKey: ['object', metricId ?? '', 'page-metric'],
    queryFn: () => http.post<MetricValue>(`/metrics/${metricId}/value`, {}),
    enabled: Boolean(metric.data),
    retry: false,
  })
  if (!metricId) return <NotPicked />
  if (!value.data) return <Skeleton className="h-24 max-w-md" />
  return (
    <NumberTile
      model={metricTileModel(value.data, t, locale, value.data.name)}
      className="max-w-md"
    />
  )
}

function DatasetBlock({ block }: { block: CellMap }) {
  const datasetId = useCellValue<string | null>(block, 'datasetId') ?? null
  const dataset = useQuery({
    ...datasetQuery(datasetId ?? ''),
    enabled: Boolean(datasetId),
    retry: false,
  })
  if (!datasetId) return <NotPicked />
  if (!dataset.data) return <Skeleton className="h-48" />
  return (
    <div className="h-80 min-h-0">
      <DatasetTable dataset={dataset.data} canEdit={false} />
    </div>
  )
}

function MapBlock({ block }: { block: CellMap }) {
  const mapId = useCellValue<string | null>(block, 'mapId') ?? null
  if (!mapId) return <NotPicked />
  return <MapEmbed mapId={mapId} className="h-80" />
}

/** Список задач проекта: открытые задачи, состояние ведёт модуль задач. */
function TasksBlock({ block }: { block: CellMap }) {
  const t = useT()
  const projectId = useCellValue<string | null>(block, 'projectId') ?? null
  const tasks = useQuery({
    ...tasksQuery({
      scope: 'all',
      state: 'open',
      limit: TASKS_LIMIT,
      ...(projectId ? { projectId } : {}),
    }),
    enabled: Boolean(projectId),
  })
  if (!projectId) return <NotPicked />
  if (!tasks.data) return <Skeleton className="h-24" />
  if (tasks.data.items.length === 0) {
    return <p className="text-xs text-fg-muted">{t('tasks.empty')}</p>
  }
  return (
    <ul className="flex flex-col gap-1">
      {tasks.data.items.map((task) => (
        <li
          key={task.id}
          className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm"
        >
          <Badge tone="outline">{task.key}</Badge>
          <span className="flex-1 truncate">{task.title}</span>
          {task.dueAt ? <span className="text-2xs text-fg-muted">{task.dueAt}</span> : null}
        </li>
      ))}
    </ul>
  )
}

/** Изображение страницы: файл реестра, подпись под ним — общий `Y.Text`. */
function ImageBlock({ block }: { block: CellMap }) {
  const t = useT()
  const { readOnly } = usePageContext()
  const fileId = useCellValue<string | null>(block, 'fileId') ?? null
  const caption = captionText(block)
  useYChanges(caption as unknown as Y.AbstractType<unknown> | null)
  if (!fileId) return <NotPicked />
  return (
    <figure className="flex flex-col gap-2">
      <FilePreview fileId={fileId} />
      {caption ? (
        <Input
          value={caption.toString()}
          onChange={(event) => applyTextChange(caption, event.target.value)}
          aria-label={t('knowledge.blocks.caption')}
          placeholder={t('knowledge.blocks.caption')}
          readOnly={readOnly}
          className="text-xs"
        />
      ) : null}
    </figure>
  )
}

/** Таблица страницы: правится целиком — побеждает последняя запись ячейки. */
function TableBlock({ block }: { block: CellMap }) {
  const t = useT()
  const { readOnly } = usePageContext()
  const columns = useCellValue<string[]>(block, 'columns') ?? []
  const rows = useCellValue<string[][]>(block, 'rows') ?? []

  const setCell = (rowIndex: number, columnIndex: number, value: string) => {
    const next = rows.map((row, index) =>
      index === rowIndex ? row.map((cell, at) => (at === columnIndex ? value : cell)) : row,
    )
    writeCell(block, { rows: next })
  }
  const addRow = () => writeCell(block, { rows: [...rows, columns.map(() => '')] })
  const addColumn = () =>
    writeCell(block, {
      columns: [...columns, t('knowledge.blocks.tableColumn', { number: columns.length + 1 })],
      rows: rows.map((row) => [...row, '']),
    })

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={index} className="border border-line bg-surface-2 p-1 text-left">
                  <Input
                    value={column}
                    readOnly={readOnly}
                    aria-label={t('knowledge.blocks.tableColumn', { number: index + 1 })}
                    onChange={(event) =>
                      writeCell(block, {
                        columns: columns.map((item, at) =>
                          at === index ? event.target.value : item,
                        ),
                      })
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={columnIndex} className="border border-line p-1">
                    <Input
                      value={cell}
                      readOnly={readOnly}
                      aria-label={`${columns[columnIndex] ?? ''} ${rowIndex + 1}`}
                      onChange={(event) => setCell(rowIndex, columnIndex, event.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {readOnly ? null : (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={addRow}>
            {t('knowledge.blocks.tableAddRow')}
          </Button>
          <Button size="sm" variant="secondary" onClick={addColumn}>
            {t('knowledge.blocks.tableAddColumn')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Содержимое блока по его виду. */
function BlockBody({ block, kind }: { block: CellMap; kind: PageBlockKind }) {
  const t = useT()
  const { readOnly, awareness, user } = usePageContext()
  const body = bodyFragment(block)

  switch (kind) {
    case 'text':
      return body ? (
        <RichTextEditor
          aria-label={t('knowledge.blocks.body')}
          placeholder={t('knowledge.blocks.bodyPlaceholder')}
          toolbar="focus"
          editable={!readOnly}
          collaboration={{ fragment: body, awareness, user }}
        />
      ) : null
    case 'table':
      return <TableBlock block={block} />
    case 'image':
      return (
        <>
          {readOnly ? null : <EmbedPicker block={block} kind={kind} type="file" />}
          <ImageBlock block={block} />
        </>
      )
    case 'file':
      return (
        <>
          {readOnly ? null : <EmbedPicker block={block} kind={kind} type="file" />}
          <FileBlock block={block} />
        </>
      )
    case 'chart':
      return (
        <>
          {readOnly ? null : <EmbedPicker block={block} kind={kind} type="chart" />}
          <ChartBlock block={block} />
        </>
      )
    case 'metric':
      return (
        <>
          {readOnly ? null : <EmbedPicker block={block} kind={kind} type="metric" />}
          <MetricBlock block={block} />
        </>
      )
    case 'dataset':
      return (
        <>
          {readOnly ? null : <EmbedPicker block={block} kind={kind} type="dataset" />}
          <DatasetBlock block={block} />
        </>
      )
    case 'map':
      return (
        <>
          {readOnly ? null : <EmbedPicker block={block} kind={kind} type="map" />}
          <MapBlock block={block} />
        </>
      )
    default:
      return (
        <>
          {readOnly ? null : <EmbedPicker block={block} kind={kind} type="project" />}
          <TasksBlock block={block} />
        </>
      )
  }
}

/** Вложенный файл: превью и ссылка на карточку файла. */
function FileBlock({ block }: { block: CellMap }) {
  const fileId = useCellValue<string | null>(block, 'fileId') ?? null
  if (!fileId) return <NotPicked />
  return <FilePreview fileId={fileId} />
}

/**
 * Карточка блока страницы (ADR-0095): панель действий, подпись и содержимое.
 * Идентификатор блока — якорь: по нему ведут оглавление и комментарий к фрагменту.
 */
export function PageBlockCard({
  id,
  block,
  kind,
  onMove,
  onRemove,
  onDuplicate,
}: {
  id: string
  block: CellMap
  kind: PageBlockKind
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
  onDuplicate: () => void
}) {
  const t = useT()
  const { readOnly, onComment } = usePageContext()
  const label = t(`knowledge.blocks.${kind}`)

  return (
    <article
      id={`page-block-${id}`}
      className="flex scroll-mt-4 flex-col gap-2 rounded-md border border-line bg-surface p-3"
      aria-label={label}
    >
      <div className="flex items-center gap-2">
        <Badge tone={TONE[kind] ?? 'neutral'}>{label}</Badge>
        <div className="flex-1" />
        <IconButton
          label={t('knowledge.blocks.comment')}
          size="sm"
          variant="ghost"
          onClick={() => onComment(id)}
        >
          <MessageSquare className="size-4" />
        </IconButton>
        {readOnly ? null : (
          <>
            <IconButton
              label={t('knowledge.blocks.moveUp')}
              size="sm"
              variant="ghost"
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton
              label={t('knowledge.blocks.moveDown')}
              size="sm"
              variant="ghost"
              onClick={() => onMove(1)}
            >
              <ArrowDown className="size-4" />
            </IconButton>
            <IconButton
              label={t('knowledge.blocks.duplicate')}
              size="sm"
              variant="ghost"
              onClick={onDuplicate}
            >
              <Copy className="size-4" />
            </IconButton>
            <IconButton
              label={t('knowledge.blocks.remove')}
              size="sm"
              variant="ghost"
              onClick={onRemove}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </>
        )}
      </div>
      <BlockTitle block={block} label={t('knowledge.blocks.title')} />
      <BlockBody block={block} kind={kind} />
    </article>
  )
}

const KINDS: PageBlockKind[] = [
  'text',
  'table',
  'image',
  'file',
  'chart',
  'map',
  'dataset',
  'metric',
  'tasks',
]

/** Кнопки «добавить блок»: текст и таблица — чаще всего, объекты — следом. */
export function AddBlockButtons({
  onAdd,
  pending,
}: {
  onAdd: (kind: PageBlockKind) => void
  pending?: boolean
}) {
  const t = useT()
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">{t('knowledge.blocks.add')}</legend>
      {pending ? <Spinner className="size-4" label={t('knowledge.blocks.add')} /> : null}
      {KINDS.map((kind) => (
        <Button key={kind} size="sm" variant="secondary" onClick={() => onAdd(kind)}>
          {t(`knowledge.blocks.${kind}`)}
        </Button>
      ))}
    </fieldset>
  )
}
