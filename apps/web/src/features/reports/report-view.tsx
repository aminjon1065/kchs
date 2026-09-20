import type { ReportBlockKind, ReportFormat, ReportSettings } from '@kchs/contracts'
import { REPORT_FORMATS } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  AlertDialog,
  AvatarGroup,
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  InlineEdit,
  Input,
  ObjectIcon,
  PanelToolbar,
  personTone,
  RichTextEditor,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Tooltip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  Copy,
  Eye,
  FileOutput,
  FileText,
  Lock,
  PanelRight,
  Plus,
  Share2,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { documentTypesQuery } from '~/features/documents/queries.js'
import { useCollabDocument } from '~/features/notebooks/collab.js'
import {
  type NotebookContextValue,
  NotebookProvider,
  useNotebook,
  usePeers,
} from '~/features/notebooks/notebook-context.js'
import {
  type CellMap,
  cellIds,
  cellsOf,
  duplicateCell,
  insertCell,
  moveCell,
  orderOf,
  paramsOf,
  readParams,
  removeCell,
  useCellValue,
  useYChanges,
  writeCell,
} from '~/features/notebooks/notebook-doc.js'
import { NotebookParamsBar } from '~/features/notebooks/notebook-params.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, objectQuery } from '~/shared/api/queries.js'
import { reportPreviewPath } from './print/print-target.js'
import { reportKeys } from './queries.js'
import { ChartBlock, MapBlock, MetricsBlock, PageBreakBlock, QueryBlock } from './report-blocks.js'
import { createBlock, readSettings, settingsOf, writeSettings } from './report-doc.js'
import { ReportRunsPanel } from './report-runs.js'
import { ReportScheduleDialog } from './schedule-dialog.js'

const ADDABLE: ReportBlockKind[] = ['text', 'query', 'chart', 'metrics', 'map', 'page_break']

const ICONS: Record<ReportBlockKind, string> = {
  text: 'page',
  query: 'query',
  chart: 'chart',
  metrics: 'metric',
  map: 'map',
  page_break: 'template',
}

interface ReportContextValue {
  reportId: string
  settings: ReportSettings
}

/**
 * Отчёт (06-analytics-engine.md §12, P2-E05 S03, ADR-0078): шаблон — документ
 * из блоков, совместный целиком (как тетрадь, ADR-0070/0071); параметры и
 * настройки печати сверху, история запусков справа, «Сформировать» — PDF/DOCX
 * движком под правами нажавшего, «Рассылка» — расписание и получатели.
 */
export default function ReportView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [toDocumentOpen, setToDocumentOpen] = useState(false)
  const [runsOpen, setRunsOpen] = useState(true)
  const { data: object, isLoading } = useQuery(objectQuery(objectId))
  const { data: me } = useQuery(meQuery())
  const collab = useCollabDocument(objectId)

  const rename = useMutation({
    mutationFn: (title: string) => http.patch(`/objects/${objectId}`, { title }),
    onSuccess: (_result, title) => {
      setTabTitle(tabId, title)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: ['objects'] })
    },
  })
  const trash = useMutation({
    mutationFn: () => http.delete(`/objects/${objectId}`),
    onSuccess: () => {
      toast.show({
        title: t('objects.trash.movedTo'),
        tone: 'info',
        action: {
          label: t('common.actions.undo'),
          onClick: () => void http.post(`/objects/${objectId}/restore`),
        },
      })
      void client.invalidateQueries({ queryKey: ['objects'] })
      closeTab(tabId)
    },
  })
  const render = useMutation({
    mutationFn: (formats: ReportFormat[]) => http.post(`/reports/${objectId}/runs`, { formats }),
    onSuccess: () => {
      toast.show({ title: t('data.report.run.started'), tone: 'info' })
      setRunsOpen(true)
      void client.invalidateQueries({ queryKey: reportKeys.runs(objectId) })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const name = me?.user.displayName ?? ''
  const user = useMemo(() => ({ name, tone: personTone(name) }), [name])
  const awareness = collab?.awareness
  useEffect(() => {
    if (awareness && name) awareness.setLocalStateField('user', user)
  }, [awareness, name, user])

  if (collab?.status === 'denied' || (!isLoading && !object)) {
    return (
      <EmptyState
        icon={<Lock />}
        title={t('data.report.denied')}
        description={t(`data.notebook.denied.${reasonKey(collab?.reason ?? null)}`)}
      />
    )
  }
  if (!object || !collab?.synced || !me) {
    return (
      <div
        className="flex flex-col gap-3 p-6"
        role="status"
        aria-label={t('data.notebook.status.connecting')}
      >
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const canManage = object.level === 'manage' || object.level === 'owner'

  return (
    <ReportScreen
      notebookId={objectId}
      spaceId={object.spaceId}
      doc={collab.doc}
      awareness={collab.awareness}
      readOnly={collab.readOnly}
      user={user}
      timezone={me.user.timezone}
      canSql={me.capabilities.includes('data.sql')}
      runsOpen={runsOpen}
      toolbar={(settings) => (
        <PanelToolbar
          left={
            <>
              <ObjectIcon type="report" className="size-4 shrink-0 text-fg-muted" />
              <InlineEdit
                value={object.title}
                disabled={collab.readOnly}
                onSave={(next) => rename.mutate(next)}
                className="text-sm font-semibold text-fg"
                aria-label={t('common.labels.name')}
              />
              <SyncBadge
                status={collab.status}
                readOnly={collab.readOnly}
                pending={collab.pending}
              />
            </>
          }
          right={
            <>
              <Peers />
              <Button
                variant="ghost"
                size="sm"
                icon={<Eye className="size-3.5" />}
                onClick={() => window.open(reportPreviewPath(objectId), '_blank', 'noopener')}
              >
                {t('data.report.preview')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<CalendarClock className="size-3.5" />}
                onClick={() => setScheduleOpen(true)}
              >
                {t('data.report.schedule.open')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<FileText className="size-3.5" />}
                onClick={() => setToDocumentOpen(true)}
              >
                {t('data.report.toDocument.open')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<FileOutput className="size-3.5" />}
                loading={render.isPending}
                onClick={() => render.mutate(settings.formats)}
              >
                {t('data.report.run.button')}
              </Button>
              <IconButton
                label={t(runsOpen ? 'data.report.runs.hide' : 'data.report.runs.show')}
                onClick={() => setRunsOpen((open) => !open)}
              >
                <PanelRight className="size-4" />
              </IconButton>
              <IconButton label={t('common.actions.share')} onClick={() => setShareOpen(true)}>
                <Share2 className="size-4" />
              </IconButton>
              {canManage ? (
                <IconButton
                  label={t('common.actions.delete')}
                  variant="danger"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              ) : null}
            </>
          }
        />
      )}
    >
      <ShareDialog
        objectId={objectId}
        title={object.title}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <ReportScheduleDialog
        reportId={objectId}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        canManage={canManage}
        timezone={me.user.timezone}
      />
      <ReportToDocumentDialog
        reportId={objectId}
        reportName={object.title}
        open={toDocumentOpen}
        onOpenChange={setToDocumentOpen}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: object.title })}
        description={t('objects.trash.hint')}
        confirmLabel={t('common.actions.delete')}
        onConfirm={() => {
          trash.mutate()
          setDeleteOpen(false)
        }}
      />
    </ReportScreen>
  )
}

/**
 * Отчёт исходящим документом (ADR-0127): выбирается вид исходящего, файл
 * последнего прогона ложится первой версией, и дальше документ идёт обычным
 * маршрутом — согласование, подпись, регистрация, рассылка.
 */
function ReportToDocumentDialog({
  reportId,
  reportName,
  open,
  onOpenChange,
}: {
  reportId: string
  reportName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const [typeId, setTypeId] = useState('')
  const { data: types = [] } = useQuery({ ...documentTypesQuery(), enabled: open })
  const outgoing = types.filter((type) => type.direction === 'outgoing')

  const create = useMutation({
    mutationFn: () =>
      http.post<{ documentId: string }>(`/reports/${reportId}/document`, { typeId }),
    onSuccess: ({ documentId }) => {
      onOpenChange(false)
      toast.show({ title: t('data.report.toDocument.created'), tone: 'success' })
      openTab({
        kind: 'object',
        objectId: documentId,
        objectType: 'document',
        title: reportName,
        mode: 'permanent',
      })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('data.report.toDocument.title')}>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-fg-secondary">{t('data.report.toDocument.hint')}</p>
          <Field label={t('data.report.toDocument.pickType')}>
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger aria-label={t('data.report.toDocument.pickType')}>
                <SelectValue placeholder={t('data.report.toDocument.pickType')} />
              </SelectTrigger>
              <SelectContent>
                {outgoing.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {localizedText(type.name, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              disabled={!typeId || create.isPending}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('data.report.toDocument.create')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function reasonKey(reason: string | null): 'unauthorized' | 'setup_required' | 'not_found' {
  return reason === 'unauthorized' || reason === 'setup_required' ? reason : 'not_found'
}

/** Отчёт с открытым документом: параметры, настройки и порядок блоков — из него. */
function ReportScreen({
  toolbar,
  children,
  runsOpen,
  ...props
}: Omit<NotebookContextValue, 'params'> & {
  toolbar: (settings: ReportSettings) => ReactNode
  children: ReactNode
  runsOpen: boolean
}) {
  const t = useT()
  const { notebookId, spaceId, doc, awareness, readOnly, user, timezone, canSql } = props
  const paramsVersion = useYChanges(paramsOf(doc) as unknown as Y.AbstractType<unknown>, true)
  const settingsVersion = useYChanges(settingsOf(doc) as unknown as Y.AbstractType<unknown>, true)
  const orderVersion = useYChanges(orderOf(doc) as unknown as Y.AbstractType<unknown>)
  const cellsVersion = useYChanges(cellsOf(doc) as unknown as Y.AbstractType<unknown>)
  // biome-ignore lint/correctness/useExhaustiveDependencies: версия документа — сигнал пересчёта
  const params = useMemo(() => readParams(doc), [doc, paramsVersion])
  // biome-ignore lint/correctness/useExhaustiveDependencies: версия документа — сигнал пересчёта
  const settings = useMemo(() => readSettings(doc), [doc, settingsVersion])
  // biome-ignore lint/correctness/useExhaustiveDependencies: версии документа — сигнал пересчёта
  const ids = useMemo(() => cellIds(doc), [doc, orderVersion, cellsVersion])
  const context = useMemo<NotebookContextValue>(
    () => ({ notebookId, spaceId, doc, awareness, readOnly, params, user, timezone, canSql }),
    [notebookId, spaceId, doc, awareness, readOnly, params, user, timezone, canSql],
  )
  const report = useMemo<ReportContextValue>(
    () => ({ reportId: notebookId, settings }),
    [notebookId, settings],
  )

  return (
    <NotebookProvider value={context}>
      <div className="flex h-full min-h-0 flex-col">
        {toolbar(settings)}
        <NotebookParamsBar label={t('data.report.params')} />
        <SettingsBar report={report} />
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <div
              className={cn(
                'mx-auto flex flex-col gap-5 px-6 py-6',
                settings.orientation === 'landscape' ? 'max-w-[1120px]' : 'max-w-[820px]',
              )}
            >
              {ids.length === 0 ? <EmptyReport /> : null}
              {ids.map((id, index) => (
                <BlockFrame key={id} id={id} index={index} count={ids.length} />
              ))}
              {readOnly ? null : <AddBlock index={ids.length} />}
            </div>
          </div>
          {runsOpen ? (
            <aside className="hidden w-72 shrink-0 border-l border-line bg-surface md:flex md:flex-col">
              <ReportRunsPanel reportId={notebookId} />
            </aside>
          ) : null}
        </div>
      </div>
      {children}
    </NotebookProvider>
  )
}

/** Настройки печати: ориентация, колонтитулы, титульный лист, форматы «Сформировать». */
function SettingsBar({ report }: { report: ReportContextValue }) {
  const t = useT()
  const { doc, readOnly } = useNotebook()
  const { settings } = report
  const [header, setHeader] = useState(settings.header)
  const [footer, setFooter] = useState(settings.footer)
  useEffect(() => setHeader(settings.header), [settings.header])
  useEffect(() => setFooter(settings.footer), [settings.footer])
  return (
    <fieldset
      disabled={readOnly}
      className="m-0 flex shrink-0 flex-wrap items-center gap-3 border-0 border-b border-line bg-surface-2 px-4 py-2"
    >
      <legend className="sr-only">{t('data.report.settings.label')}</legend>
      <span aria-hidden className="text-2xs font-medium tracking-wide text-fg-muted uppercase">
        {t('data.report.settings.label')}
      </span>
      <SegmentedControl
        size="sm"
        aria-label={t('data.report.settings.orientation')}
        value={settings.orientation}
        onValueChange={(next) => !readOnly && writeSettings(doc, { orientation: next })}
        options={[
          { value: 'portrait', label: t('data.report.settings.portrait') },
          { value: 'landscape', label: t('data.report.settings.landscape') },
        ]}
      />
      <Input
        aria-label={t('data.report.settings.header')}
        placeholder={t('data.report.settings.headerPlaceholder')}
        value={header}
        maxLength={200}
        className="h-7 w-52 text-xs"
        onChange={(event) => setHeader(event.target.value)}
        onBlur={() => header !== settings.header && writeSettings(doc, { header })}
      />
      <Input
        aria-label={t('data.report.settings.footer')}
        placeholder={t('data.report.settings.footerPlaceholder')}
        value={footer}
        maxLength={200}
        className="h-7 w-52 text-xs"
        onChange={(event) => setFooter(event.target.value)}
        onBlur={() => footer !== settings.footer && writeSettings(doc, { footer })}
      />
      <Switch
        checked={settings.titlePage}
        onCheckedChange={(next) => writeSettings(doc, { titlePage: next })}
        label={t('data.report.settings.titlePage')}
      />
      <fieldset className="m-0 flex items-center gap-3 border-0 p-0">
        <legend className="sr-only">{t('data.report.settings.formats')}</legend>
        {REPORT_FORMATS.map((format) => (
          <Checkbox
            key={format}
            checked={settings.formats.includes(format)}
            onCheckedChange={(next) => {
              const formats = next
                ? [...new Set([...settings.formats, format])]
                : settings.formats.filter((item) => item !== format)
              if (formats.length > 0) writeSettings(doc, { formats })
            }}
            label={format.toUpperCase()}
          />
        ))}
      </fieldset>
    </fieldset>
  )
}

/** Состояние документа: подключение, сохранение, только чтение, нет связи. */
function SyncBadge({
  status,
  readOnly,
  pending,
}: {
  status: 'connecting' | 'ready' | 'offline' | 'denied'
  readOnly: boolean
  pending: boolean
}) {
  const t = useT()
  if (status === 'connecting')
    return <Badge size="sm">{t('data.notebook.status.connecting')}</Badge>
  if (status === 'offline') {
    return (
      <Badge size="sm" tone="warning">
        {t('data.notebook.status.offline')}
      </Badge>
    )
  }
  if (readOnly) return <Badge size="sm">{t('data.notebook.status.readOnly')}</Badge>
  return (
    <span role="status" className="text-2xs text-fg-muted">
      {pending ? t('data.notebook.status.saving') : t('data.notebook.status.saved')}
    </span>
  )
}

function Peers() {
  const t = useT()
  const { awareness } = useNotebook()
  const peers = usePeers(awareness)
  if (peers.length === 0) return null
  const names = [...new Set(peers.map((peer) => peer.name))]
  const label = t('objects.presence', { names: names.join(', ') })
  return (
    <Tooltip content={label}>
      {/* biome-ignore lint/a11y/useSemanticElements: группа аватаров — не поле формы, fieldset не подходит */}
      <span role="group" aria-label={label} className="inline-flex">
        <AvatarGroup people={names.map((person) => ({ name: person }))} size="sm" max={4} />
      </span>
    </Tooltip>
  )
}

function EmptyReport() {
  const t = useT()
  const { readOnly } = useNotebook()
  return (
    <EmptyState
      compact
      icon={<ObjectIcon type="report" />}
      title={t('data.report.empty.title')}
      description={readOnly ? undefined : t('data.report.empty.hint')}
    />
  )
}

/** Меню «+ блок»: вид блока — на позицию `index`. */
function AddBlock({ index, compact = false }: { index: number; compact?: boolean }) {
  const t = useT()
  const toast = useToast()
  const { doc } = useNotebook()
  const add = (kind: ReportBlockKind) => {
    const block = createBlock(kind)
    if (!insertCell(doc, block, index)) {
      toast.show({ title: t('data.report.tooManyBlocks'), tone: 'warning' })
      return
    }
    window.setTimeout(() => {
      const element = document.getElementById(`report-block-${block.id}`)
      element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      const target =
        element?.querySelector<HTMLElement>('[contenteditable="true"], input, button') ?? element
      target?.focus({ preventScroll: true })
    }, 50)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <IconButton label={t('data.report.insertHere')} size="sm" variant="secondary">
            <Plus className="size-3.5" />
          </IconButton>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            className="self-start"
          >
            {t('data.report.addBlock')}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {ADDABLE.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => add(kind)}>
            <ObjectIcon type={ICONS[kind]} className="size-4 text-fg-muted" />
            {t(`data.report.kinds.${kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Рамка блока: панель при фокусе, соавторы в блоке, подпись и содержимое по виду. */
function BlockFrame({ id, index, count }: { id: string; index: number; count: number }) {
  const t = useT()
  const { doc, awareness, readOnly } = useNotebook()
  const cell = cellsOf(doc).get(id) as CellMap
  const kind = (useCellValue<ReportBlockKind>(cell, 'kind') ?? 'text') as ReportBlockKind
  const title = useCellValue<string | null>(cell, 'title') ?? null
  const peers = usePeers(awareness).filter((peer) => peer.cell === id)
  const kindLabel = t(`data.report.kinds.${kind}`)

  return (
    <section
      id={`report-block-${id}`}
      aria-label={t('data.report.blockLabel', { kind: kindLabel, n: index + 1 })}
      tabIndex={-1}
      className={cn(
        'group relative rounded-md border border-line bg-surface px-4 pt-5 pb-4',
        'transition-colors focus-within:border-line-strong',
      )}
      onFocus={() => {
        if (awareness.getLocalState()?.cell !== id) awareness.setLocalStateField('cell', id)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          awareness.setLocalStateField('cell', null)
        }
      }}
    >
      {peers.length > 0 ? (
        <div className="absolute -top-3 left-3 flex items-center gap-1 rounded-sm border border-line bg-surface px-1.5 py-0.5 shadow-sm">
          <AvatarGroup people={peers.map((peer) => ({ name: peer.name }))} size="xs" max={3} />
          <span className="text-2xs text-fg-secondary">
            {t('data.notebook.cell.editing', { names: peers.map((peer) => peer.name).join(', ') })}
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          'absolute -top-3.5 right-3 flex items-center gap-0.5 rounded-sm border border-line bg-surface p-0.5 shadow-sm',
          'opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        <span className="flex items-center gap-1 px-1.5 text-2xs font-medium text-fg-secondary">
          <ObjectIcon type={ICONS[kind]} className="size-3.5 text-fg-muted" />
          {kindLabel}
        </span>
        {readOnly ? null : (
          <>
            <IconButton
              label={t('data.notebook.cell.moveUp')}
              size="sm"
              disabled={index === 0}
              onClick={() => moveCell(doc, id, -1)}
            >
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton
              label={t('data.notebook.cell.moveDown')}
              size="sm"
              disabled={index === count - 1}
              onClick={() => moveCell(doc, id, 1)}
            >
              <ArrowDown className="size-3.5" />
            </IconButton>
            <IconButton
              label={t('data.notebook.cell.duplicate')}
              size="sm"
              onClick={() => duplicateCell(doc, id)}
            >
              <Copy className="size-3.5" />
            </IconButton>
            <IconButton
              label={t('data.report.removeBlock')}
              size="sm"
              variant="danger"
              onClick={() => removeCell(doc, id)}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            <AddBlock index={index + 1} compact />
          </>
        )}
      </div>
      {kind === 'text' || kind === 'page_break' ? null : (
        <div className="mb-3 flex items-center gap-2">
          <InlineEdit
            value={title ?? ''}
            placeholder={kindLabel}
            disabled={readOnly}
            onSave={(next) => writeCell(cell, { title: next.slice(0, 200) })}
            className="text-sm font-semibold text-fg"
            aria-label={t('data.report.blockTitle')}
          />
        </div>
      )}
      <BlockBody cell={cell} id={id} kind={kind} />
    </section>
  )
}

function BlockBody({ cell, id, kind }: { cell: CellMap; id: string; kind: ReportBlockKind }) {
  switch (kind) {
    case 'text':
      return <TextBlock cell={cell} />
    case 'query':
      return <QueryBlock cell={cell} id={id} />
    case 'chart':
      return <ChartBlock cell={cell} id={id} />
    case 'metrics':
      return <MetricsBlock cell={cell} />
    case 'map':
      return <MapBlock cell={cell} />
    case 'page_break':
      return <PageBreakBlock />
  }
}

/** Текст: RichTextEditor над фрагментом блока — курсоры соавторов в тексте. */
function TextBlock({ cell }: { cell: CellMap }) {
  const t = useT()
  const { awareness, readOnly, user } = useNotebook()
  const body = cell.get('body')
  if (!(body instanceof Y.XmlFragment)) return null
  return (
    <RichTextEditor
      aria-label={t('data.report.kinds.text')}
      placeholder={t('data.report.textPlaceholder')}
      toolbar="focus"
      editable={!readOnly}
      collaboration={{ fragment: body, awareness, user }}
    />
  )
}
