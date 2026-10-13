import type { ChartSpec, ChartType, ExplorePlan, QuerySpec } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'
import { ObjectPicker } from '~/entities/objects/object-picker.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { exploreApi, exploreFailure, type QueryCell } from './explore-queries.js'

/**
 * Куда унести результат «Исследования» (ADR-0217), кроме «Сохранить как график»:
 * ячейкой в тетрадь, плиткой на дашборд; и показать запрос, который построен из
 * шагов конструктора.
 */

type Dialogs = 'notebook' | 'dashboard' | 'query' | null

/** Идентификатор ячейки или плитки: латиница и цифры, как требует контракт. */
const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export function ExploreSaveMenu({
  datasetId,
  spaceId,
  name,
  plan,
  view,
  chartType,
  chartSpec,
  spec,
}: {
  datasetId: string
  spaceId: string
  name: string
  plan: ExplorePlan
  view: 'chart' | 'table' | 'map'
  chartType: ChartType | null
  /** Спецификация графика результата; у карты — нет. */
  chartSpec: ChartSpec | null
  spec: QuerySpec
}) {
  const t = useT()
  const [open, setOpen] = useState<Dialogs>(null)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t('data.explore.more')} size="sm">
            <Ellipsis className="size-3.5" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen('notebook')}>
            {t('data.explore.toNotebook')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!chartSpec} onSelect={() => setOpen('dashboard')}>
            {t('data.explore.toDashboard')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen('query')}>
            {t('data.explore.showQuery')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === 'notebook' ? (
        <NotebookDialog
          datasetId={datasetId}
          spaceId={spaceId}
          name={name}
          plan={plan}
          view={view === 'table' ? 'table' : 'chart'}
          chartType={view === 'table' ? null : chartType}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === 'dashboard' && chartSpec ? (
        <DashboardDialog
          spaceId={spaceId}
          name={name}
          spec={{ ...chartSpec, type: view === 'table' ? 'table' : chartSpec.type }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === 'query' ? <QueryDialog spec={spec} onClose={() => setOpen(null)} /> : null}
    </>
  )
}

const NEW = '__new'

function NotebookDialog({
  datasetId,
  spaceId,
  name,
  plan,
  view,
  chartType,
  onClose,
}: {
  datasetId: string
  spaceId: string
  name: string
  plan: ExplorePlan
  view: 'chart' | 'table'
  chartType: ChartType | null
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: notebooks } = useQuery(objectListQuery({ types: 'notebook', limit: 100 }))
  const [target, setTarget] = useState<string>(NEW)
  const [failure, setFailure] = useState<string | null>(null)
  const cell: QueryCell = {
    id: newId('q'),
    kind: 'query',
    title: name,
    mode: 'visual',
    sql: '',
    datasetId,
    plan,
    view,
    chartType,
    bindings: {},
  }
  const save = useMutation({
    mutationFn: () =>
      target === NEW
        ? exploreApi.createNotebook(name, spaceId, cell)
        : exploreApi.addToNotebook(target, cell),
    onSuccess: ({ id, title }) => {
      toast.show({ title: t('data.explore.addedToNotebook'), tone: 'success' })
      onClose()
      openTab({ kind: 'object', objectId: id, objectType: 'notebook', title, mode: 'permanent' })
    },
    onError: (error) => setFailure(exploreFailure(error).message ?? t('errors.unknown')),
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('data.explore.toNotebookTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {t('data.explore.add')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('data.explore.notebook')}>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger aria-label={t('data.explore.notebook')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW}>{t('data.explore.newNotebook', { name })}</SelectItem>
                {(notebooks?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DashboardDialog({
  spaceId,
  name,
  spec,
  onClose,
}: {
  spaceId: string
  name: string
  spec: ChartSpec
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)
  const [dashboardId, setDashboardId] = useState<string | null>(null)
  const [title, setTitle] = useState(name)
  const [failure, setFailure] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (id: string) =>
      exploreApi.addDashboardTile(id, title.trim() || name, spec, newId('t')),
    onSuccess: ({ id, title: dashboardTitle }) => {
      toast.show({ title: t('data.explore.addedToDashboard'), tone: 'success' })
      onClose()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'dashboard',
        title: dashboardTitle,
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(exploreFailure(error).message ?? t('errors.unknown')),
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('data.explore.toDashboardTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!dashboardId}
              loading={save.isPending}
              onClick={() => dashboardId && save.mutate(dashboardId)}
            >
              {t('data.explore.add')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <ObjectPicker
            type="dashboard"
            value={dashboardId}
            onChange={setDashboardId}
            label={t('data.explore.dashboard')}
            placeholder={t('data.explore.dashboard')}
            spaceId={spaceId}
          />
          <Field label={t('data.explore.name')}>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label={t('data.explore.name')}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function QueryDialog({ spec, onClose }: { spec: QuerySpec; onClose: () => void }) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent title={t('data.explore.queryTitle')} size="lg">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-fg-secondary">{t('data.explore.queryHint')}</p>
          <pre className="max-h-96 overflow-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-xs text-fg">
            {JSON.stringify(spec.steps, null, 2)}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  )
}
