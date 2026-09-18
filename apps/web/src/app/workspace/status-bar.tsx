import { Badge, cn, ProgressBar, Tooltip } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Activity, CircleDot, Keyboard, UserCog, Wifi, WifiOff } from 'lucide-react'
import { jobsQuery, meQuery } from '~/shared/api/queries.js'
import { useRealtimeStatus } from '~/shared/realtime/client.js'
import { useT } from '../i18n.js'

export function StatusBar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const t = useT()
  const status = useRealtimeStatus()
  const { data: me } = useQuery(meQuery())
  const { data: jobs } = useQuery(jobsQuery())

  const running = (jobs ?? []).filter((job) => job.status === 'running' || job.status === 'queued')
  const acting = me?.actingFor?.[0]

  return (
    <footer className="flex h-(--statusbar-h) shrink-0 items-center gap-3 border-t border-line bg-surface-2 px-3 text-2xs text-fg-muted">
      <span className="flex items-center gap-1.5">
        {status === 'connected' ? (
          <Wifi className="size-3 text-success" aria-hidden />
        ) : status === 'connecting' ? (
          <CircleDot className="size-3 animate-pulse-soft text-warning" aria-hidden />
        ) : (
          <WifiOff className="size-3 text-danger" aria-hidden />
        )}
        {status === 'connected'
          ? t('common.states.connected')
          : status === 'connecting'
            ? t('common.states.reconnecting')
            : t('common.states.offline')}
      </span>

      {running.length > 0 ? (
        <span className="flex items-center gap-2">
          <Activity className="size-3" aria-hidden />
          {t('shell.status.jobs', { count: running.length })}
          <ProgressBar
            value={running[0]?.progress ?? 0}
            className="w-24"
            label={running[0]?.name}
          />
        </span>
      ) : null}

      {acting ? (
        <Badge tone="warning" size="sm">
          <UserCog className="size-3" aria-hidden />
          {t('shell.status.acting', { name: acting.fromUser.displayName })}
        </Badge>
      ) : null}

      <button
        type="button"
        onClick={onShowShortcuts}
        className={cn('ml-auto flex items-center gap-1.5 rounded-xs px-1 hover:text-fg-secondary')}
      >
        <Keyboard className="size-3" aria-hidden />
        {t('shell.status.shortcuts')}
        <kbd className="rounded-xs border border-line bg-surface px-1">?</kbd>
      </button>
      <Tooltip content={t('shell.status.version')}>
        <span className="tabular">v0.1.0</span>
      </Tooltip>
    </footer>
  )
}
