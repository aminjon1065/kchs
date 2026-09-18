import { formatDateTime, formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Card,
  EmptyState,
  PanelToolbar,
  SearchInput,
  SegmentedControl,
  Skeleton,
  StatTile,
  TableSkeleton,
  Tree,
  type TreeNode,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  Building2,
  Database,
  HardDrive,
  ScrollText,
  Search,
  Server,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { auditQuery, healthQuery, orgUnitsQuery, usersQuery } from '~/shared/api/queries.js'

type Section = 'health' | 'users' | 'org' | 'audit'

export function AdminScreen() {
  const t = useT()
  const [section, setSection] = useState<Section>('health')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('admin.title')}</h1>}
        right={
          <SegmentedControl
            size="sm"
            aria-label="Раздел"
            value={section}
            onValueChange={(next) => setSection(next as Section)}
            options={[
              {
                value: 'health',
                label: t('admin.sections.health'),
                icon: <Server className="size-3.5" />,
              },
              {
                value: 'users',
                label: t('admin.sections.users'),
                icon: <Users className="size-3.5" />,
              },
              {
                value: 'org',
                label: t('admin.sections.org'),
                icon: <Building2 className="size-3.5" />,
              },
              {
                value: 'audit',
                label: t('admin.sections.audit'),
                icon: <ScrollText className="size-3.5" />,
              },
            ]}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        {section === 'health' ? <HealthSection /> : null}
        {section === 'users' ? <UsersSection /> : null}
        {section === 'org' ? <OrgSection /> : null}
        {section === 'audit' ? <AuditSection /> : null}
      </div>
    </div>
  )
}

const COMPONENT_ICONS: Record<string, typeof Server> = {
  postgres: Database,
  redis: Activity,
  meilisearch: Search,
  storage: HardDrive,
}

function HealthSection() {
  const t = useT()
  const { data, isLoading } = useQuery(healthQuery())

  if (isLoading) {
    return (
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.components.map((component) => {
          const Icon = COMPONENT_ICONS[component.name] ?? Server
          return (
            <div
              key={component.name}
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-fg-muted" aria-hidden />
                <span className="text-sm font-medium text-fg">{component.name}</span>
                <Badge
                  className="ml-auto"
                  tone={component.status === 'ok' ? 'success' : 'danger'}
                  dot
                  size="sm"
                >
                  {t(`admin.health.${component.status}`)}
                </Badge>
              </div>
              <div className="tabular text-xs text-fg-muted">
                {component.latencyMs !== null ? `${component.latencyMs} мс` : '—'}
              </div>
              {component.detail ? <p className="text-xs text-danger">{component.detail}</p> : null}
            </div>
          )
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile
          label={t('admin.health.outboxPending', { count: data.outbox.pending })}
          value={data.outbox.pending}
        />
        <StatTile label="Заданий в очереди" value={data.jobs.queued} />
        <StatTile label="Выполняется" value={data.jobs.running} />
        <StatTile label="Ошибок за сутки" value={data.jobs.failed} />
      </div>

      <Card title="Инсталляция">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-fg-muted">Версия</dt>
          <dd className="tabular">{data.version}</dd>
          <dt className="text-fg-muted">Время работы</dt>
          <dd className="tabular">{Math.floor(data.uptimeSeconds / 60)} мин</dd>
          <dt className="text-fg-muted">Состояние</dt>
          <dd>
            <Badge tone={data.status === 'ok' ? 'success' : 'warning'} dot>
              {t(`admin.health.${data.status}`)}
            </Badge>
          </dd>
        </dl>
      </Card>
    </div>
  )
}

function UsersSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search, 250)
  const { data, isLoading } = useQuery(usersQuery({ q: query || undefined, limit: 100 }))

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-5">
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder="Имя, логин или почта"
        className="max-w-sm"
      />
      <Card padded={false}>
        {isLoading ? (
          <TableSkeleton rows={8} columns={4} />
        ) : !data?.items.length ? (
          <EmptyState compact icon={<Users />} title={t('common.states.empty')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th className="h-8 px-3 font-medium">{t('common.labels.name')}</th>
                <th className="h-8 px-3 font-medium">{t('common.labels.login')}</th>
                <th className="h-8 px-3 font-medium">{t('common.labels.unit')}</th>
                <th className="h-8 px-3 font-medium">MFA</th>
                <th className="h-8 px-3 font-medium">{t('common.labels.status')}</th>
                <th className="h-8 px-3 font-medium">Активность</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((user) => (
                <tr key={user.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="h-(--row-h) px-3">{user.displayName}</td>
                  <td className="px-3 font-mono text-xs text-fg-secondary">{user.login}</td>
                  <td className="px-3 text-xs text-fg-secondary">
                    {user.units.find((unit) => unit.isPrimary)?.name ?? '—'}
                  </td>
                  <td className="px-3">
                    {user.mfaEnabled ? (
                      <Badge tone="success" size="sm">
                        вкл
                      </Badge>
                    ) : (
                      <span className="text-xs text-fg-muted">—</span>
                    )}
                  </td>
                  <td className="px-3">
                    <Badge tone={user.status === 'active' ? 'success' : 'neutral'} size="sm" dot>
                      {t(`admin.users.status.${user.status}`)}
                    </Badge>
                  </td>
                  <td className="px-3 text-xs text-fg-muted">
                    {user.lastSeenAt ? formatRelativeTime(user.lastSeenAt, { locale }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function OrgSection() {
  const t = useT()
  const { data: units = [], isLoading } = useQuery(orgUnitsQuery())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)

  const nodes: TreeNode[] = buildTree(units, null, t)

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3 p-5">
      <Card title={t('admin.sections.org')} padded={false}>
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : (
          <div className="p-2">
            <Tree
              nodes={nodes}
              selectedId={selected}
              expandedIds={expanded}
              onToggle={(id) =>
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onSelect={(node) => setSelected(node.id)}
            />
          </div>
        )}
      </Card>
    </div>
  )
}

function buildTree(
  units: Array<{
    id: string
    parentId: string | null
    name: { ru: string }
    code: string
    employeeCount: number
    head: { displayName: string } | null
  }>,
  parentId: string | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): TreeNode[] {
  return units
    .filter((unit) => unit.parentId === parentId)
    .map((unit) => ({
      id: unit.id,
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{unit.name.ru}</span>
          <span className="shrink-0 font-mono text-2xs text-fg-muted">{unit.code}</span>
        </span>
      ),
      icon: <Building2 className="size-4" />,
      badge: (
        <span className="tabular shrink-0 text-2xs text-fg-muted">
          {t('admin.org.employees', { count: unit.employeeCount })}
        </span>
      ),
      children: buildTree(units, unit.id, t),
    }))
}

function AuditSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const [action, setAction] = useState('')
  const query = useDebouncedValue(action, 250)
  const { data, isLoading } = useQuery(auditQuery({ action: query || undefined, limit: 100 }))

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-5">
      <SearchInput
        value={action}
        onValueChange={setAction}
        placeholder="Действие, например user.login"
        className="max-w-sm"
      />
      <Card padded={false}>
        {isLoading ? (
          <TableSkeleton rows={10} columns={4} />
        ) : !data?.items.length ? (
          <EmptyState compact icon={<ScrollText />} title={t('admin.audit.empty')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th className="h-8 px-3 font-medium">Время</th>
                <th className="h-8 px-3 font-medium">{t('admin.audit.filterAction')}</th>
                <th className="h-8 px-3 font-medium">Объект</th>
                <th className="h-8 px-3 font-medium">IP</th>
                <th className="h-8 px-3 font-medium">Важность</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-line last:border-0 hover:bg-surface-2"
                >
                  <td className="h-(--row-h) whitespace-nowrap px-3 font-mono text-xs text-fg-secondary">
                    {formatDateTime(entry.occurredAt, { locale })}
                  </td>
                  <td className="px-3 font-mono text-xs">{entry.action}</td>
                  <td className="px-3 text-xs text-fg-secondary">{entry.objectType ?? '—'}</td>
                  <td className="px-3 font-mono text-xs text-fg-muted">{entry.ip ?? '—'}</td>
                  <td className="px-3">
                    <Badge
                      size="sm"
                      tone={
                        entry.severity === 'critical'
                          ? 'danger'
                          : entry.severity === 'warning'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {entry.severity}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
