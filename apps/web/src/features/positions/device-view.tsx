import type { PositionFix } from '@kchs/contracts'
import { formatDateTime, formatNumber } from '@kchs/fields'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  EmptyState,
  PanelToolbar,
  Skeleton,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, PenLine } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { onRealtimeEvent } from '~/shared/realtime/client.js'
import { DeviceDialog } from './device-dialog.js'
import { LinkBadge } from './link-badge.js'
import { applyPosition, deviceQuery, deviceTrackQuery, positionKeys } from './queries.js'

/** Координаты — пять знаков после запятой (около метра), без разрядов. */
const COORD = { precision: 5, thousands: false }

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="min-w-0 text-fg">{children}</span>
    </div>
  )
}

/**
 * Карточка устройства слежения (ADR-0203): номер, вид, «Силы и средства», кто
 * передаёт, последняя точка и связь, трек за сутки. Вкладка подписана на комнату
 * устройства: новая точка приходит сразу.
 */
export function DeviceView({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useLocale()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  // Сутки от открытия вкладки: ключ трека не меняется при каждой отрисовке
  const [from] = useState(() => new Date(Date.now() - 86_400_000).toISOString())
  const { data: device, isLoading } = useQuery(deviceQuery(objectId))
  const { data: track } = useQuery(deviceTrackQuery(objectId, from))

  useEffect(
    () =>
      onRealtimeEvent('position.updated', (payload) => {
        applyPosition(client, payload)
        if (payload.deviceId === objectId) {
          void client.invalidateQueries({ queryKey: ['positions', 'track', objectId] })
        }
      }),
    [client, objectId],
  )

  if (isLoading || !device) return <Skeleton className="m-6 h-64" />

  const columns: Array<DataTableColumn<PositionFix>> = [
    {
      key: 'at',
      header: t('positions.track.at'),
      width: 180,
      cell: (row) => formatDateTime(row.at, { locale }),
    },
    {
      key: 'coordinates',
      header: t('positions.track.coordinates'),
      width: 220,
      cell: (row) => (
        <span className="font-mono text-xs">
          {t('positions.coordinates', {
            lat: formatNumber(row.lat, COORD, { locale }),
            lon: formatNumber(row.lon, COORD, { locale }),
          })}
        </span>
      ),
    },
    {
      key: 'speed',
      header: t('positions.fields.speed'),
      width: 120,
      cell: (row) =>
        row.speed === null
          ? '—'
          : t('positions.speedValue', { value: formatNumber(row.speed, {}, { locale }) }),
    },
    {
      key: 'battery',
      header: t('positions.fields.battery'),
      width: 100,
      cell: (row) =>
        row.battery === null
          ? '—'
          : t('positions.batteryValue', { value: formatNumber(row.battery, {}, { locale }) }),
    },
  ]
  const points = [...(track?.points ?? [])].reverse()

  return (
    <section aria-label={device.name} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <span className="truncate text-sm font-semibold text-fg">{device.name}</span>
            <LinkBadge link={device.active ? device.link : 'never'} />
          </>
        }
        right={
          device.can.edit ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<PenLine className="size-3.5" />}
              onClick={() => setEditing(true)}
            >
              {t('positions.edit')}
            </Button>
          ) : null
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-canvas p-5">
        <Card title={t('positions.editTitle')}>
          <Row label={t('positions.fields.externalId')}>
            <span className="font-mono text-xs">{device.externalId}</span>
          </Row>
          <Row label={t('positions.fields.kind')}>{t(`positions.kinds.${device.kind}`)}</Row>
          <Row label={t('positions.fields.forcesCode')}>{device.forcesCode ?? '—'}</Row>
          <Row label={t('positions.fields.reporter')}>{device.reporter?.displayName ?? '—'}</Row>
          <Row label={t('positions.fields.active')}>
            <Badge tone={device.active ? 'success' : 'neutral'} size="sm">
              {device.active ? t('positions.states.active') : t('positions.states.inactive')}
            </Badge>
          </Row>
          <Row label={t('positions.fields.last')}>
            {device.last
              ? `${formatDateTime(device.last.at, { locale })} · ${t('positions.coordinates', {
                  lat: formatNumber(device.last.lat, COORD, { locale }),
                  lon: formatNumber(device.last.lon, COORD, { locale }),
                })}`
              : '—'}
          </Row>
          {device.note ? <Row label={t('positions.fields.note')}>{device.note}</Row> : null}
        </Card>
        <Card title={t('positions.track.title')}>
          {points.length === 0 ? (
            <EmptyState
              compact
              icon={<MapPin className="size-5" />}
              title={t('positions.track.empty')}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {track?.truncated ? (
                <span className="text-xs text-fg-muted">
                  {t('positions.track.truncated', { count: points.length })}
                </span>
              ) : null}
              <div className="h-80 min-h-0">
                <DataTable
                  rows={points}
                  getRowId={(row) => row.at}
                  columns={columns}
                  aria-label={t('positions.track.title')}
                />
              </div>
            </div>
          )}
        </Card>
      </div>
      {editing ? (
        <DeviceDialog
          device={device}
          open={editing}
          onOpenChange={(next) => {
            setEditing(next)
            if (!next) void client.invalidateQueries({ queryKey: positionKeys.device(objectId) })
          }}
        />
      ) : null}
    </section>
  )
}
