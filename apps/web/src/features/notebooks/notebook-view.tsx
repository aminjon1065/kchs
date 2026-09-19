import type { NotebookCellKind } from '@kchs/contracts'
import {
  AlertDialog,
  AvatarGroup,
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  InlineEdit,
  ObjectIcon,
  PanelToolbar,
  personTone,
  RichTextEditor,
  Skeleton,
  Tooltip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Copy, Lock, Play, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { http } from '~/shared/api/client.js'
import { keys, meQuery, objectQuery } from '~/shared/api/queries.js'
import { notebookKeys } from './cell-run.js'
import { useCollabDocument } from './collab.js'
import { MapCell } from './map-cell.js'
import {
  type NotebookContextValue,
  NotebookProvider,
  useNotebook,
  usePeers,
} from './notebook-context.js'
import {
  type CellMap,
  cellIds,
  cellsOf,
  createCell,
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
} from './notebook-doc.js'
import { iconOf, NotebookOutline } from './notebook-outline.js'
import { NotebookParamsBar } from './notebook-params.js'
import { AiCell, QueryCell } from './query-cell.js'
import { ChartCell, MetricCell } from './source-cells.js'

/** Виды ячеек, которые добавляются из меню; карта — позже (ADR-0071). */
const ADDABLE: NotebookCellKind[] = ['text', 'query', 'ai', 'chart', 'metric', 'map']

/**
 * Тетрадь (03-screens.md §9, ADR-0071): документ с ячейками — совместный
 * целиком. Слева оглавление, сверху параметры, ячейка при фокусе показывает
 * панель (тип, выполнить, переставить, дублировать, удалить), курсоры и
 * присутствие соавторов — в тексте и на ячейках.
 */
export default function NotebookView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
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

  const name = me?.user.displayName ?? ''
  const user = useMemo(() => ({ name, tone: personTone(name) }), [name])
  const awareness = collab?.awareness
  // Присутствие на уровне тетради: кто открыл документ и в какой он ячейке
  useEffect(() => {
    if (awareness && name) awareness.setLocalStateField('user', user)
  }, [awareness, name, user])

  if (collab?.status === 'denied' || (!isLoading && !object)) {
    return (
      <EmptyState
        icon={<Lock />}
        title={t('data.notebook.denied.title')}
        description={t(`data.notebook.denied.${reasonKey(collab?.reason ?? null)}`)}
      />
    )
  }
  // До первой синхронизации документ пуст — показывать его рано
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
    <NotebookScreen
      notebookId={objectId}
      spaceId={object.spaceId}
      doc={collab.doc}
      awareness={collab.awareness}
      readOnly={collab.readOnly}
      user={user}
      timezone={me.user.timezone}
      canSql={me.capabilities.includes('data.sql')}
      toolbar={
        <PanelToolbar
          left={
            <>
              <ObjectIcon type="notebook" className="size-4 shrink-0 text-fg-muted" />
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
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="size-3.5" />}
                onClick={() => {
                  void client.invalidateQueries({ queryKey: notebookKeys.all(objectId) })
                  toast.show({ title: t('data.notebook.recalcStarted'), tone: 'info' })
                }}
              >
                {t('data.notebook.recalc')}
              </Button>
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
      }
    >
      <ShareDialog
        objectId={objectId}
        title={object.title}
        open={shareOpen}
        onOpenChange={setShareOpen}
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
    </NotebookScreen>
  )
}

function reasonKey(reason: string | null): 'unauthorized' | 'setup_required' | 'not_found' {
  return reason === 'unauthorized' || reason === 'setup_required' ? reason : 'not_found'
}

/**
 * Тетрадь с открытым документом: параметры и порядок ячеек читаются из него и
 * перерисовываются вместе с правками соавторов.
 */
function NotebookScreen({
  toolbar,
  children,
  ...props
}: Omit<NotebookContextValue, 'params'> & { toolbar: ReactNode; children: ReactNode }) {
  const { notebookId, spaceId, doc, awareness, readOnly, user, timezone, canSql } = props
  const paramsVersion = useYChanges(paramsOf(doc) as unknown as Y.AbstractType<unknown>, true)
  const orderVersion = useYChanges(orderOf(doc) as unknown as Y.AbstractType<unknown>)
  const cellsVersion = useYChanges(cellsOf(doc) as unknown as Y.AbstractType<unknown>)
  // biome-ignore lint/correctness/useExhaustiveDependencies: версия документа — сигнал пересчёта
  const params = useMemo(() => readParams(doc), [doc, paramsVersion])
  // biome-ignore lint/correctness/useExhaustiveDependencies: версии документа — сигнал пересчёта
  const ids = useMemo(() => cellIds(doc), [doc, orderVersion, cellsVersion])
  const context = useMemo<NotebookContextValue>(
    () => ({ notebookId, spaceId, doc, awareness, readOnly, params, user, timezone, canSql }),
    [notebookId, spaceId, doc, awareness, readOnly, params, user, timezone, canSql],
  )

  const jump = useCallback((cellId: string) => {
    const element = document.getElementById(`notebook-cell-${cellId}`)
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    element?.focus({ preventScroll: true })
  }, [])

  return (
    <NotebookProvider value={context}>
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        <NotebookParamsBar />
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-line bg-surface-2 md:block">
            <NotebookOutline onJump={jump} />
          </aside>
          <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-6 py-6">
              {ids.length === 0 ? <EmptyNotebook /> : null}
              {ids.map((id, index) => (
                <CellFrame key={id} id={id} index={index} count={ids.length} />
              ))}
              {readOnly ? null : <AddCell index={ids.length} />}
            </div>
          </div>
        </div>
      </div>
      {children}
    </NotebookProvider>
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

/** Соавторы, открывшие тетрадь: аватары тех же цветов, что их курсоры. */
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

function EmptyNotebook() {
  const t = useT()
  const { readOnly } = useNotebook()
  return (
    <EmptyState
      compact
      icon={<ObjectIcon type="notebook" />}
      title={t('data.notebook.empty.title')}
      description={readOnly ? undefined : t('data.notebook.empty.hint')}
    />
  )
}

/** Меню «+ ячейка»: вид ячейки — на позицию `index`. */
function AddCell({ index, compact = false }: { index: number; compact?: boolean }) {
  const t = useT()
  const toast = useToast()
  const { doc } = useNotebook()
  const add = (kind: NotebookCellKind) => {
    const cell = createCell(kind)
    if (!insertCell(doc, cell, index)) {
      toast.show({ title: t('data.notebook.tooManyCells'), tone: 'warning' })
      return
    }
    // Новая ячейка — в фокус, когда появится в разметке
    window.setTimeout(() => {
      const element = document.getElementById(`notebook-cell-${cell.id}`)
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
          <IconButton label={t('data.notebook.insertHere')} size="sm" variant="secondary">
            <Plus className="size-3.5" />
          </IconButton>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            className="self-start"
          >
            {t('data.notebook.addCell')}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {ADDABLE.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => add(kind)}>
            <ObjectIcon type={iconOf(kind)} className="size-4 text-fg-muted" />
            {t(`data.notebook.kinds.${kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Рамка ячейки: панель ячейки при фокусе или наведении, соавторы в ячейке,
 * подпись (кроме текста), содержимое по виду. Фокус в ячейке — в присутствии:
 * соавторы видят, кто где работает.
 */
function CellFrame({ id, index, count }: { id: string; index: number; count: number }) {
  const t = useT()
  const client = useQueryClient()
  const { doc, awareness, readOnly, notebookId } = useNotebook()
  const cell = cellsOf(doc).get(id) as CellMap
  const kind = (useCellValue<NotebookCellKind>(cell, 'kind') ?? 'text') as NotebookCellKind
  const title = useCellValue<string | null>(cell, 'title') ?? null
  const peers = usePeers(awareness).filter((peer) => peer.cell === id)
  const kindLabel = t(`data.notebook.kinds.${kind}`)
  const label = t('data.notebook.cell.label', { kind: kindLabel, n: index + 1 })

  return (
    <section
      id={`notebook-cell-${id}`}
      aria-label={label}
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
          <ObjectIcon type={iconOf(kind)} className="size-3.5 text-fg-muted" />
          {kindLabel}
        </span>
        {kind !== 'text' && kind !== 'map' ? (
          <IconButton
            label={t('data.notebook.cell.run')}
            size="sm"
            onClick={() =>
              void client.invalidateQueries({
                queryKey: [...notebookKeys.all(notebookId), 'cell', id],
              })
            }
          >
            <Play className="size-3.5" />
          </IconButton>
        ) : null}
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
              label={t('data.notebook.cell.remove')}
              size="sm"
              variant="danger"
              onClick={() => removeCell(doc, id)}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            <AddCell index={index + 1} compact />
          </>
        )}
      </div>

      {kind === 'text' ? null : (
        <div className="mb-3 flex items-center gap-2">
          <InlineEdit
            value={title ?? ''}
            placeholder={kindLabel}
            disabled={readOnly}
            onSave={(next) => writeCell(cell, { title: next.slice(0, 200) })}
            className="text-sm font-semibold text-fg"
            aria-label={t('data.notebook.cell.title')}
          />
        </div>
      )}
      <CellBody cell={cell} id={id} kind={kind} />
    </section>
  )
}

function CellBody({ cell, id, kind }: { cell: CellMap; id: string; kind: NotebookCellKind }) {
  switch (kind) {
    case 'text':
      return <TextCell cell={cell} />
    case 'query':
      return <QueryCell cell={cell} cellId={id} />
    case 'ai':
      return <AiCell cell={cell} cellId={id} />
    case 'chart':
      return <ChartCell cell={cell} cellId={id} />
    case 'metric':
      return <MetricCell cell={cell} cellId={id} />
    case 'map':
      return <MapCell cell={cell} />
  }
}

/** Текстовая ячейка: RichTextEditor над фрагментом ячейки — курсоры соавторов в тексте. */
function TextCell({ cell }: { cell: CellMap }) {
  const t = useT()
  const { awareness, readOnly, user } = useNotebook()
  const body = cell.get('body')
  if (!(body instanceof Y.XmlFragment)) return null
  return (
    <RichTextEditor
      aria-label={t('data.notebook.kinds.text')}
      placeholder={t('data.notebook.text.placeholder')}
      toolbar="focus"
      editable={!readOnly}
      collaboration={{ fragment: body, awareness, user }}
    />
  )
}
