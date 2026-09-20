import { DEFAULT_CLEARANCE } from '@kchs/contracts'
import { formatDateTime, formatRelativeTime } from '@kchs/fields'
import { type Locale, type LocalizedText, localizedText } from '@kchs/i18n'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PanelToolbar,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatTile,
  TableSkeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tree,
  type TreeNode,
  useDebouncedValue,
  useMediaQuery,
  useToast,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Building2,
  Cable,
  CalendarClock,
  CalendarDays,
  Contact,
  Database,
  DatabaseBackup,
  Download,
  FileJson,
  FileSpreadsheet,
  HardDrive,
  KeyRound,
  LayoutGrid,
  Map as MapIcon,
  Megaphone,
  Palette,
  Plus,
  Route,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  Shuffle,
  Ticket,
  ToggleLeft,
  UserPlus,
  Users,
  Workflow,
  Zap,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { AutomationRulesSection } from '~/features/automation/rules-section.js'
import { SchedulesSection } from '~/features/automation/schedules-section.js'
import { ProcessesSection } from '~/features/processes/processes-section.js'
import {
  auditQuery,
  healthQuery,
  keys,
  meQuery,
  orgUnitsQuery,
  rolesQuery,
  usersQuery,
} from '~/shared/api/queries.js'
import { AnnouncementsSection } from './announcements-section.js'
import { ApiTokensSection } from './api-tokens-section.js'
import { BackupsSection } from './backups-section.js'
import { BasemapsSection } from './basemaps-section.js'
import { BrandingSection } from './branding-section.js'
import { BusinessCalendarSection } from './business-calendar-section.js'
import { ConfigPackageSection } from './config-package-section.js'
import { DirectorySection } from './directory-section.js'
import { FeaturesSection } from './features-section.js'
import { IntegrationsSection } from './integrations-section.js'
import { CreateUnitDialog } from './org-management.js'
import { RolesSection } from './roles-section.js'
import { SecuritySection } from './security-section.js'
import { SpacesSection } from './spaces-section.js'
import { SsoSection } from './sso-section.js'
import { TasksSection } from './tasks-section.js'
import { CreateUserDialog, UserActions } from './user-management.js'
import { UsersImportDialog } from './users-import-dialog.js'

type Section =
  | 'health'
  | 'users'
  | 'org'
  | 'roles'
  | 'spaces'
  | 'announcements'
  | 'business-calendar'
  | 'basemaps'
  | 'audit'
  | 'security'
  | 'features'
  | 'branding'
  | 'backups'
  | 'directory'
  | 'sso'
  | 'tasks'
  | 'processes'
  | 'integrations'
  | 'apiTokens'
  | 'config'
  | 'automation'
  | 'schedules'

/**
 * Консоль администрирования (15-admin-operations.md §1): разделы — вертикальные
 * вкладки слева (на узком экране — строкой сверху). Разделы, требующие
 * `admin.system`, видит только администратор системы; проверяет сервер.
 */
export function AdminScreen() {
  const t = useT()
  const [section, setSection] = useState<Section>('health')
  // Переход из матрицы ролей: «Пользователи» с фильтром по роли
  const [roleFilter, setRoleFilter] = useState<string | null>(null)
  const { data: me } = useQuery(meQuery())
  const isSystemAdmin = me?.capabilities.includes('admin.system') ?? false
  const canManageBasemaps = me?.capabilities.includes('gis.basemaps.manage') ?? false
  const canManageProcesses = me?.capabilities.includes('processes.manage') ?? false
  const canManageIntegrations = me?.capabilities.includes('automation.manage') ?? false
  const canManageAutomation = me?.capabilities.includes('automation.manage') ?? false
  const wide = useMediaQuery('(min-width: 768px)')

  const sections: Array<{ value: Section; label: string; icon: ReactNode; visible: boolean }> = [
    {
      value: 'health',
      label: t('admin.sections.health'),
      icon: <Server className="size-3.5" />,
      visible: true,
    },
    {
      value: 'users',
      label: t('admin.sections.users'),
      icon: <Users className="size-3.5" />,
      visible: true,
    },
    {
      value: 'org',
      label: t('admin.sections.org'),
      icon: <Building2 className="size-3.5" />,
      visible: true,
    },
    {
      value: 'roles',
      label: t('admin.sections.roles'),
      icon: <KeyRound className="size-3.5" />,
      visible: true,
    },
    {
      value: 'spaces',
      label: t('admin.sections.spaces'),
      icon: <LayoutGrid className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'announcements',
      label: t('admin.sections.announcements'),
      icon: <Megaphone className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'business-calendar',
      label: t('admin.sections.businessCalendar'),
      icon: <CalendarDays className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'basemaps',
      label: t('admin.sections.basemaps'),
      icon: <MapIcon className="size-3.5" />,
      visible: canManageBasemaps,
    },
    {
      value: 'audit',
      label: t('admin.sections.audit'),
      icon: <ScrollText className="size-3.5" />,
      visible: true,
    },
    {
      value: 'security',
      label: t('admin.sections.security'),
      icon: <ShieldCheck className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'features',
      label: t('admin.sections.features'),
      icon: <ToggleLeft className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'branding',
      label: t('admin.sections.branding'),
      icon: <Palette className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'backups',
      label: t('admin.sections.backups'),
      icon: <DatabaseBackup className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'directory',
      label: t('admin.sections.directory'),
      icon: <Contact className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'sso',
      label: t('admin.sections.sso'),
      icon: <Shuffle className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'tasks',
      label: t('admin.sections.tasks'),
      icon: <Workflow className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'processes',
      label: t('admin.sections.processes'),
      icon: <Route className="size-3.5" />,
      visible: canManageProcesses,
    },
    {
      value: 'integrations',
      label: t('admin.sections.integrations'),
      icon: <Cable className="size-3.5" />,
      visible: canManageIntegrations,
    },
    {
      value: 'apiTokens',
      label: t('admin.sections.apiTokens'),
      icon: <Ticket className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'config',
      label: t('admin.sections.config'),
      icon: <FileJson className="size-3.5" />,
      visible: isSystemAdmin,
    },
    {
      value: 'automation',
      label: t('admin.sections.automation'),
      icon: <Zap className="size-3.5" />,
      visible: canManageAutomation,
    },
    {
      value: 'schedules',
      label: t('admin.sections.schedules'),
      icon: <CalendarClock className="size-3.5" />,
      visible: canManageAutomation,
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar left={<h1 className="text-sm font-semibold text-fg">{t('admin.title')}</h1>} />
      <Tabs
        value={section}
        onValueChange={(next) => setSection(next as Section)}
        orientation={wide ? 'vertical' : 'horizontal'}
        className="flex min-h-0 flex-1 flex-col md:flex-row"
      >
        <TabsList
          aria-label={t('admin.sectionLabel')}
          className="shrink-0 overflow-x-auto px-2 md:w-56 md:overflow-visible md:border-r md:border-line md:bg-surface md:p-2"
        >
          {sections
            .filter((item) => item.visible)
            .map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.icon}
                {item.label}
              </TabsTrigger>
            ))}
        </TabsList>
        <TabsContent value="health" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
          <HealthSection />
        </TabsContent>
        <TabsContent value="users" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
          <UsersSection roleKey={roleFilter} onRoleKeyChange={setRoleFilter} />
        </TabsContent>
        <TabsContent value="org" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
          <OrgSection />
        </TabsContent>
        <TabsContent value="roles" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
          <RolesSection
            onShowHolders={(roleKey) => {
              setRoleFilter(roleKey)
              setSection('users')
            }}
          />
        </TabsContent>
        {isSystemAdmin ? (
          <>
            <TabsContent value="spaces" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <SpacesSection />
            </TabsContent>
            <TabsContent value="announcements" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <AnnouncementsSection />
            </TabsContent>
            <TabsContent
              value="business-calendar"
              className="min-h-0 flex-1 overflow-y-auto bg-canvas"
            >
              <BusinessCalendarSection />
            </TabsContent>
            <TabsContent value="features" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <FeaturesSection />
            </TabsContent>
            <TabsContent value="branding" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <BrandingSection />
            </TabsContent>
            <TabsContent value="backups" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <BackupsSection />
            </TabsContent>
            <TabsContent value="security" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <SecuritySection />
            </TabsContent>
            <TabsContent value="directory" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <DirectorySection />
            </TabsContent>
            <TabsContent value="sso" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <SsoSection />
            </TabsContent>
            <TabsContent value="tasks" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <TasksSection />
            </TabsContent>
            <TabsContent value="apiTokens" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <ApiTokensSection />
            </TabsContent>
            <TabsContent value="config" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <ConfigPackageSection />
            </TabsContent>
          </>
        ) : null}
        {canManageIntegrations ? (
          <TabsContent value="integrations" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <IntegrationsSection />
          </TabsContent>
        ) : null}
        {canManageBasemaps ? (
          <TabsContent value="basemaps" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <BasemapsSection />
          </TabsContent>
        ) : null}
        {canManageProcesses ? (
          <TabsContent value="processes" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <ProcessesSection />
          </TabsContent>
        ) : null}
        {canManageAutomation ? (
          <>
            <TabsContent value="automation" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <AutomationRulesSection />
            </TabsContent>
            <TabsContent value="schedules" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
              <SchedulesSection />
            </TabsContent>
          </>
        ) : null}
        <TabsContent value="audit" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
          <AuditSection />
        </TabsContent>
      </Tabs>
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
                {component.latencyMs !== null
                  ? t('admin.health.latencyMs', { ms: component.latencyMs })
                  : '—'}
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
        <StatTile label={t('admin.health.jobsQueued')} value={data.jobs.queued} />
        <StatTile label={t('admin.health.jobsRunning')} value={data.jobs.running} />
        <StatTile label={t('admin.health.jobsFailed')} value={data.jobs.failed} />
      </div>

      <Card title={t('admin.health.installation')}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-fg-muted">{t('admin.health.version')}</dt>
          <dd className="tabular">{data.version}</dd>
          <dt className="text-fg-muted">{t('admin.health.uptime')}</dt>
          <dd className="tabular">
            {t('admin.health.uptimeMinutes', { minutes: Math.floor(data.uptimeSeconds / 60) })}
          </dd>
          <dt className="text-fg-muted">{t('admin.health.state')}</dt>
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

const ALL_ROLES = '*'

function UsersSection({
  roleKey,
  onRoleKeyChange,
}: {
  roleKey: string | null
  onRoleKeyChange: (roleKey: string | null) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const query = useDebouncedValue(search, 250)
  const { data: roles = [] } = useQuery(rolesQuery())
  const { data, isLoading } = useQuery(
    usersQuery({ q: query || undefined, roleKey: roleKey ?? undefined, limit: 100 }),
  )
  const { data: me } = useQuery(meQuery())
  const canManage = me?.capabilities.includes('users.manage') ?? false
  const isSystemAdmin = me?.capabilities.includes('admin.system') ?? false
  const refresh = () => void client.invalidateQueries({ queryKey: ['users'] })

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-5">
      <div className="flex items-center gap-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('admin.users.searchPlaceholder')}
          className="max-w-sm"
        />
        <Select
          value={roleKey ?? ALL_ROLES}
          onValueChange={(next) => onRoleKeyChange(next === ALL_ROLES ? null : next)}
        >
          <SelectTrigger aria-label={t('admin.users.roleFilter')} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ROLES}>{t('admin.users.allRoles')}</SelectItem>
            {roles.map((role) => (
              <SelectItem key={role.key} value={role.key}>
                {localizedText(role.name, locale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage ? (
          <div className="ml-auto flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<FileSpreadsheet className="size-3.5" />}
              onClick={() => setImporting(true)}
            >
              {t('admin.users.import')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<UserPlus className="size-3.5" />}
              onClick={() => setCreating(true)}
            >
              {t('admin.users.create')}
            </Button>
          </div>
        ) : null}
      </div>
      <UsersImportDialog open={importing} onOpenChange={setImporting} />
      <CreateUserDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          toast.show({ title: t('admin.users.createdToast'), tone: 'success' })
          refresh()
        }}
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
                <th className="h-8 px-3 font-medium">{t('admin.users.columns.mfa')}</th>
                {isSystemAdmin ? (
                  <th className="h-8 px-3 font-medium">{t('access.clearance.label')}</th>
                ) : null}
                <th className="h-8 px-3 font-medium">{t('common.labels.status')}</th>
                <th className="h-8 px-3 font-medium">{t('admin.users.columns.lastSeen')}</th>
                {canManage ? (
                  <th className="h-8 w-10 px-3 font-medium">
                    <span className="sr-only">{t('ui.table.actions')}</span>
                  </th>
                ) : null}
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
                        {t('admin.users.mfaOn')}
                      </Badge>
                    ) : (
                      <span className="text-xs text-fg-muted">—</span>
                    )}
                  </td>
                  {isSystemAdmin ? (
                    <td className="px-3">
                      <Badge
                        size="sm"
                        title={t(`access.confidentiality.${user.clearance ?? DEFAULT_CLEARANCE}`)}
                      >
                        {t(`access.confidentialityShort.${user.clearance ?? DEFAULT_CLEARANCE}`)}
                      </Badge>
                    </td>
                  ) : null}
                  <td className="px-3">
                    <Badge tone={user.status === 'active' ? 'success' : 'neutral'} size="sm" dot>
                      {t(`admin.users.status.${user.status}`)}
                    </Badge>
                  </td>
                  <td className="px-3 text-xs text-fg-muted">
                    {user.lastSeenAt ? formatRelativeTime(user.lastSeenAt, { locale }) : '—'}
                  </td>
                  {canManage ? (
                    <td className="px-3 text-right">
                      <UserActions user={user} onChanged={refresh} />
                    </td>
                  ) : null}
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
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const toast = useToast()
  const { data: units = [], isLoading } = useQuery(orgUnitsQuery())
  const { data: me } = useQuery(meQuery())
  const canManage = me?.capabilities.includes('org.manage') ?? false
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const nodes: TreeNode[] = buildTree(units, null, t, locale)

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3 p-5">
      <CreateUnitDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          toast.show({ title: t('admin.org.created'), tone: 'success' })
          void client.invalidateQueries({ queryKey: keys.orgUnits })
        }}
      />
      <Card
        title={t('admin.sections.org')}
        padded={false}
        action={
          canManage ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setCreating(true)}
            >
              {t('admin.org.createUnit')}
            </Button>
          ) : null
        }
      >
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
    name: LocalizedText
    code: string
    employeeCount: number
    head: { displayName: string } | null
  }>,
  parentId: string | null,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: Locale,
): TreeNode[] {
  return units
    .filter((unit) => unit.parentId === parentId)
    .map((unit) => ({
      id: unit.id,
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{localizedText(unit.name, locale)}</span>
          <span className="shrink-0 font-mono text-2xs text-fg-muted">{unit.code}</span>
        </span>
      ),
      icon: <Building2 className="size-4" />,
      badge: (
        <span className="tabular shrink-0 text-2xs text-fg-muted">
          {t('admin.org.employees', { count: unit.employeeCount })}
        </span>
      ),
      children: buildTree(units, unit.id, t, locale),
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
      <div className="flex items-center gap-2">
        <SearchInput
          value={action}
          onValueChange={setAction}
          placeholder={t('admin.audit.searchPlaceholder')}
          className="max-w-sm"
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<Download className="size-3.5" />}
          className="ml-auto"
          asChild
        >
          {/* Потоковая выгрузка с сервера: cookie-сессия, GET без CSRF */}
          <a
            href={`/api/v1/admin/audit/export.csv${query ? `?action=${encodeURIComponent(query)}` : ''}`}
            download
          >
            {t('admin.audit.export')}
          </a>
        </Button>
      </div>
      <Card padded={false}>
        {isLoading ? (
          <TableSkeleton rows={10} columns={4} />
        ) : !data?.items.length ? (
          <EmptyState compact icon={<ScrollText />} title={t('admin.audit.empty')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th className="h-8 px-3 font-medium">{t('admin.audit.columns.time')}</th>
                <th className="h-8 px-3 font-medium">{t('admin.audit.filterAction')}</th>
                <th className="h-8 px-3 font-medium">{t('admin.audit.columns.object')}</th>
                <th className="h-8 px-3 font-medium">{t('admin.audit.columns.ip')}</th>
                <th className="h-8 px-3 font-medium">{t('admin.audit.columns.severity')}</th>
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
                      {t(`admin.audit.severity.${entry.severity}`)}
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
