import type { DashboardRecord, DashboardTile } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { nextId, orderedTiles, packTiles } from './dashboard-layout.js'
import { dataKeys } from './queries.js'

const NEW = '__new'

/** Новый дашборд в пространстве — сразу открывается во вкладке. */
export function CreateDashboardDialog({
  spaceId,
  onClose,
}: {
  spaceId: string
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => http.post<{ id: string }>('/dashboards', { name: name.trim(), spaceId }),
    onSuccess: ({ id }) => {
      toast.show({ title: t('data.dashboard.created'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['objects'] })
      onClose()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'dashboard',
        title: name.trim(),
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.dashboard.createTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('data.dashboard.name')}>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={t('data.dashboard.name')}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** График — плиткой на существующий или новый дашборд пространства. */
export function AddToDashboardDialog({
  chart,
  onClose,
}: {
  chart: { id: string; name: string; spaceId: string }
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: dashboards } = useQuery(
    objectListQuery({ spaceId: chart.spaceId, types: 'dashboard', limit: 100 }),
  )
  const [target, setTarget] = useState<string>(NEW)
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const tileFor = (tiles: DashboardTile[]): DashboardTile => ({
    id: nextId(
      't',
      tiles.map((tile) => tile.id),
    ),
    kind: 'chart',
    chartId: chart.id,
    title: chart.name,
    filterBindings: {},
    x: 0,
    y: Math.max(0, ...tiles.map((tile) => tile.y + tile.h)),
    w: 6,
    h: 4,
  })

  const add = useMutation({
    mutationFn: async (): Promise<{ id: string; title: string }> => {
      if (target === NEW) {
        const created = await http.post<{ id: string }>('/dashboards', {
          name: name.trim(),
          spaceId: chart.spaceId,
          spec: { tiles: [tileFor([])] },
        })
        return { id: created.id, title: name.trim() }
      }
      const dashboard = await http.get<DashboardRecord>(`/dashboards/${target}`)
      const tiles = orderedTiles(dashboard.spec.tiles)
      await http.patch(`/dashboards/${target}`, {
        spec: { ...dashboard.spec, tiles: packTiles([...tiles, tileFor(tiles)]) },
      })
      return { id: target, title: dashboard.name }
    },
    onSuccess: ({ id, title }) => {
      toast.show({ title: t('data.dashboard.added'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: dataKeys.dashboard(id) })
      void client.invalidateQueries({ queryKey: ['dashboard', id, 'data'] })
      onClose()
      openTab({ kind: 'object', objectId: id, objectType: 'dashboard', title, mode: 'permanent' })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const ready = target !== NEW || Boolean(name.trim())
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.dashboard.addToDashboardTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              {t('data.dashboard.addToDashboard')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('data.dashboard.addToDashboardTitle')}>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger aria-label={t('data.dashboard.addToDashboardTitle')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW}>{t('data.dashboard.newDashboard')}</SelectItem>
                {(dashboards?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {target === NEW ? (
            <Field label={t('data.dashboard.name')}>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label={t('data.dashboard.name')}
              />
            </Field>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
