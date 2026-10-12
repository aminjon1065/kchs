import type { DeviceRecord } from '@kchs/contracts'
import { formatNumber, formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Plus, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { meQuery, spacesQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { onRealtimeEvent, subscribeRooms, unsubscribeRooms } from '~/shared/realtime/client.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { DeviceDialog } from './device-dialog.js'
import { LinkBadge } from './link-badge.js'
import { applyPosition, devicesQuery } from './queries.js'
import { PositionsSettingsDialog } from './settings-dialog.js'

/**
 * Экран «Устройства слежения» (ADR-0203): трекеры техники и телефоны групп с
 * последней точкой и связью. Новые точки приходят в реальном времени — экран держит
 * комнаты своих устройств и правит строки на месте.
 */
export function DevicesScreen() {
  const t = useT()
  const locale = useLocale()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [spaceId, setSpaceId] = useState('all')
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 250)
  const [creating, setCreating] = useState(false)
  const [settings, setSettings] = useState(false)

  const { data: me } = useQuery(meQuery())
  const { data: spaces = [] } = useQuery(spacesQuery())
  const { data, isLoading } = useQuery(
    devicesQuery({ ...(spaceId === 'all' ? {} : { spaceId }), ...(q ? { q } : {}) }),
  )
  const items = data?.items ?? []
  const admin = (me?.capabilities ?? []).includes('admin.system')

  // Комнаты устройств списка: права на каждую проверяет шлюз
  const roomKey = items.map((item) => item.id).join(',')
  useEffect(() => {
    const rooms = roomKey ? roomKey.split(',').map((id) => `object:${id}`) : []
    if (rooms.length === 0) return
    subscribeRooms(rooms)
    return () => unsubscribeRooms(rooms)
  }, [roomKey])
  useEffect(
    () => onRealtimeEvent('device.located', (payload) => applyPosition(client, payload)),
    [client],
  )

  const open = (device: DeviceRecord) =>
    openTab({
      kind: 'object',
      objectId: device.id,
      objectType: 'device',
      title: device.name,
      icon: 'device',
      mode: 'permanent',
    })

  const columns: Array<DataTableColumn<DeviceRecord>> = [
    {
      key: 'name',
      header: t('positions.fields.name'),
      width: 240,
      cell: (row) => <span className="truncate font-medium">{row.name}</span>,
    },
    {
      key: 'externalId',
      header: t('positions.fields.externalId'),
      width: 170,
      cell: (row) => <span className="truncate font-mono text-xs">{row.externalId}</span>,
    },
    {
      key: 'kind',
      header: t('positions.fields.kind'),
      width: 160,
      cell: (row) => <Badge tone="neutral">{t(`positions.kinds.${row.kind}`)}</Badge>,
    },
    {
      key: 'link',
      header: t('positions.fields.link'),
      width: 200,
      cell: (row) => (
        <span className="flex items-center gap-2 text-xs">
          <LinkBadge link={row.active ? row.link : 'never'} />
          {row.last ? (
            <span className="text-fg-muted">{formatRelativeTime(row.last.at, { locale })}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'speed',
      header: t('positions.fields.speed'),
      width: 110,
      cell: (row) =>
        row.last?.speed !== null && row.last?.speed !== undefined
          ? t('positions.speedValue', { value: formatNumber(row.last.speed, {}, { locale }) })
          : '—',
    },
    {
      key: 'battery',
      header: t('positions.fields.battery'),
      width: 100,
      cell: (row) =>
        row.last?.battery !== null && row.last?.battery !== undefined
          ? t('positions.batteryValue', { value: formatNumber(row.last.battery, {}, { locale }) })
          : '—',
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-canvas p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-fg">{t('positions.title')}</h2>
          <p className="text-sm text-fg-secondary">{t('positions.hint')}</p>
        </div>
        <div className="flex gap-2">
          {admin ? (
            <Button
              variant="secondary"
              icon={<Settings className="size-4" />}
              onClick={() => setSettings(true)}
            >
              {t('positions.settings.open')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setCreating(true)}
          >
            {t('positions.create')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('positions.search')}
          aria-label={t('positions.search')}
          className="w-64"
        />
        <Select value={spaceId} onValueChange={setSpaceId}>
          <SelectTrigger aria-label={t('positions.space')} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('positions.allSpaces')}</SelectItem>
            {spaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<MapPin className="size-5" />}
          title={t('positions.empty.title')}
          description={t('positions.empty.description')}
        />
      ) : (
        <div className="h-[28rem] min-h-0">
          <DataTable
            rows={items}
            getRowId={(row) => row.id}
            columns={columns}
            onRowClick={open}
            onRowOpen={open}
            aria-label={t('positions.title')}
          />
        </div>
      )}

      {creating ? (
        <DeviceDialog
          device={null}
          open={creating}
          onOpenChange={setCreating}
          onSaved={(id, name) =>
            openTab({
              kind: 'object',
              objectId: id,
              objectType: 'device',
              title: name,
              icon: 'device',
              mode: 'permanent',
            })
          }
        />
      ) : null}
      {settings ? <PositionsSettingsDialog open={settings} onOpenChange={setSettings} /> : null}
    </div>
  )
}
