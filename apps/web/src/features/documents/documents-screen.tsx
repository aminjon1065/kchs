import type { DocumentStatus, FilterNode, ObjectSummary, UserRef } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  type CollectionState,
  CollectionView,
  cn,
  type DataTableColumn,
  EmptyState,
  PanelToolbar,
  StatusBadge,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  AlarmClock,
  AlertTriangle,
  Archive,
  BookOpen,
  Briefcase,
  Building2,
  CheckSquare,
  FilePen,
  FileSignature,
  FileText,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  LibraryBig,
  type LucideIcon,
  Mail,
  Plus,
  Search as SearchIcon,
  Send,
  Stamp,
  UserCheck,
  UserRound,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import type { TabState } from '~/app/workspace/types.js'
import { meQuery } from '~/shared/api/queries.js'
import { emptyCollectionState } from '~/shared/collections/collection-state.js'
import { SavedViewsMenu } from '~/shared/collections/saved-views-menu.js'
import { useListFields } from '~/shared/collections/use-list-fields.js'
import { useObjectCollection } from '~/shared/collections/use-object-collection.js'
import {
  describeUserFilterValue,
  renderUserFilterValue,
} from '~/shared/collections/user-filter-value.js'
import { CreateDocumentDialog } from './create-document-dialog.js'
import { CasesDirectory } from './directories/cases-directory.js'
import { CorrespondentsDirectory } from './directories/correspondents-directory.js'
import { JournalsDirectory } from './directories/journals-directory.js'
import { TemplatesDirectory } from './directories/templates-directory.js'
import { TypesDirectory } from './directories/types-directory.js'
import { MailScreen } from './mail/mail-screen.js'
import { documentSummaryQuery, journalsQuery, officeDashboardQuery } from './queries.js'
import { RegistrationScreen } from './registration/registration-screen.js'
import { CONFIDENTIALITY_TONE, DOCUMENT_STATUS_TONE, localToday } from './status.js'

const TYPES = ['document']

/**
 * Встроенные представления навигатора (03-screens.md §12, ADR-0086): мои, на
 * согласовании у меня, мои на контроле, все на контроле, просроченные на
 * контроле, просроченные, к отправке, журнал входящих текущего года,
 * черновики, архив.
 */
const PRESETS = [
  'all',
  'mine',
  'approval',
  'myControl',
  'control',
  'controlOverdue',
  'overdue',
  'toDispatch',
  'incomingYear',
  'drafts',
  'archive',
] as const
type Preset = (typeof PRESETS)[number]

const PRESET_ICONS: Record<Preset, LucideIcon> = {
  all: Inbox,
  mine: UserRound,
  approval: FileSignature,
  myControl: UserCheck,
  control: CheckSquare,
  controlOverdue: AlarmClock,
  overdue: AlertTriangle,
  toDispatch: Send,
  incomingYear: BookOpen,
  drafts: FilePen,
  archive: Archive,
}

const OPEN: FilterNode = { field: 'closed', op: 'is_false' }
const ON_CONTROL: FilterNode = { field: 'control', op: 'in', value: ['on'] }
const OVERDUE: FilterNode = { field: 'deadline', op: 'before', value: '@today' }
/** Статусы маршрута до регистрации: согласование и подпись. */
const APPROVAL_STATUSES = ['on_approval', 'returned', 'approved', 'on_signing', 'signed']
const anyMe = (...fields: string[]): FilterNode => ({
  or: fields.map((field) => ({ field, op: 'is_me' })),
})

/** Фильтр представления — поверх фильтра пользователя, в сохранённые не попадает. */
function presetFilter(preset: Preset, journalId: string | null, year: number): FilterNode | null {
  if (journalId) return { field: 'journalId', op: 'in', value: [journalId] }
  switch (preset) {
    case 'mine':
      return { and: [OPEN, anyMe('responsibleId', 'authorId', 'signerId', 'controllerId')] }
    case 'approval':
      // Участники маршрута — источник прав `route:*`; в карточке — автор, ответственный, подписант
      return {
        and: [
          { field: 'status', op: 'in', value: APPROVAL_STATUSES },
          anyMe('authorId', 'responsibleId', 'signerId'),
        ],
      }
    case 'myControl':
      return { and: [OPEN, ON_CONTROL, anyMe('controllerId', 'responsibleId')] }
    case 'control':
      return { and: [OPEN, ON_CONTROL] }
    case 'controlOverdue':
      return { and: [OPEN, ON_CONTROL, OVERDUE] }
    case 'overdue':
      return { and: [OPEN, OVERDUE] }
    case 'toDispatch':
      return {
        and: [
          { field: 'direction', op: 'in', value: ['outgoing'] },
          { field: 'status', op: 'in', value: ['registered'] },
          { field: 'dispatched', op: 'is_false' },
        ],
      }
    case 'incomingYear':
      return {
        and: [
          { field: 'direction', op: 'in', value: ['incoming'] },
          { field: 'regDate', op: 'between', value: [`${year}-01-01`, `${year}-12-31`] },
        ],
      }
    case 'drafts':
      return {
        and: [
          { field: 'status', op: 'in', value: ['draft'] },
          { field: 'authorId', op: 'is_me' },
        ],
      }
    case 'archive':
      return { field: 'status', op: 'in', value: ['filed', 'archived'] }
    default:
      return null
  }
}

function combine(a: FilterNode | null, b: FilterNode | null): FilterNode | null {
  if (a && b) return { and: [a, b] }
  return a ?? b
}

export interface DocumentsScreenState {
  preset?: Preset
  journalId?: string | null
  collection?: CollectionState
  viewId?: string | null
}

/**
 * Экран «Документы» (03-screens.md §12): навигатор представлений и журналов,
 * CollectionView-таблица, «Зарегистрировать» и «Создать» (по типу или шаблону).
 * Параметр вкладки `view` открывает регистрацию и справочники.
 */
export function DocumentsScreen({ tab }: { tab: TabState }) {
  switch (tab.params.view) {
    case 'register':
      return <RegistrationScreen />
    case 'journals':
      return <JournalsDirectory selectedId={tab.params.id ?? null} />
    case 'correspondents':
      return <CorrespondentsDirectory selectedId={tab.params.id ?? null} />
    case 'types':
      return <TypesDirectory selectedId={tab.params.id ?? null} />
    case 'cases':
      return <CasesDirectory selectedId={tab.params.id ?? null} />
    case 'templates':
      return <TemplatesDirectory selectedId={tab.params.id ?? null} />
    case 'mail':
      return <MailScreen />
    default:
      return <DocumentsList tabId={tab.id} savedState={tab.state as DocumentsScreenState} />
  }
}

function DocumentsList({
  tabId,
  savedState,
}: {
  tabId: string
  savedState?: DocumentsScreenState
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)
  const { data: me } = useQuery(meQuery())
  const { data: summary } = useQuery(documentSummaryQuery())
  const { data: journals = [] } = useQuery(journalsQuery())
  const { data: office } = useQuery(officeDashboardQuery())
  const year = Number(localToday().slice(0, 4))
  const [preset, setPreset] = useState<Preset>(savedState?.preset ?? 'all')
  const [journalId, setJournalId] = useState<string | null>(savedState?.journalId ?? null)
  const [collection, setCollection] = useState<CollectionState>(
    () => savedState?.collection ?? emptyCollectionState('table'),
  )
  const [viewId, setViewId] = useState<string | null>(savedState?.viewId ?? null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    setTabState(tabId, { preset, journalId, collection, viewId })
  }, [tabId, preset, journalId, collection, viewId, setTabState])

  const { fields, sortable } = useListFields(TYPES)
  const effective: CollectionState = {
    ...collection,
    filter: combine(presetFilter(preset, journalId, year), collection.filter),
  }
  const { rows, total, loading, hasMore, loadMore } = useObjectCollection(
    { types: TYPES },
    effective,
  )
  const canRegister = me?.capabilities.includes('documents.register') ?? false

  const openDocument = (item: ObjectSummary, permanent = false) =>
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: 'document',
      title: item.subtitle ? `${item.subtitle} · ${item.title}` : item.title,
      mode: permanent ? 'permanent' : 'preview',
    })
  // Глиф вкладки — тип объекта справочника (ObjectIcon), регистрация — документ
  const openScreen = (view: string, title: string, icon: string) =>
    openTab({
      kind: 'screen',
      screen: 'documents',
      title,
      icon,
      params: { view },
      mode: 'permanent',
    })

  const meta = (item: ObjectSummary) => item.meta as Record<string, unknown>
  const text = (value: unknown) =>
    typeof value === 'string' && value ? value : <span className="text-fg-muted">—</span>

  const columns: Array<DataTableColumn<ObjectSummary>> = [
    {
      key: 'regNumber',
      header: t('documents.fields.regNumber'),
      width: 130,
      sortable: sortable.includes('regNumber'),
      cell: (item) =>
        meta(item).regNumber ? (
          <span className="font-mono text-xs tabular">{String(meta(item).regNumber)}</span>
        ) : (
          <span className="text-xs text-fg-muted">{t('documents.draftShort')}</span>
        ),
    },
    {
      key: 'regDate',
      header: t('documents.fields.regDate'),
      width: 110,
      sortable: sortable.includes('regDate'),
      cell: (item) =>
        typeof meta(item).regDate === 'string' ? (
          <span className="tabular">{formatDate(String(meta(item).regDate), { locale })}</span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      key: 'type',
      header: t('documents.fields.type'),
      width: 170,
      cell: (item) => {
        const name = meta(item).typeName as { ru: string; tg?: string; en?: string } | undefined
        return (
          <span className="truncate text-fg-secondary">
            {name ? (name[locale] ?? name.ru) : '—'}
          </span>
        )
      },
    },
    {
      key: 'title',
      header: t('documents.fields.subject'),
      minWidth: 260,
      sortable: sortable.includes('title'),
      cell: (item) => <span className="truncate">{item.title}</span>,
    },
    {
      key: 'correspondent',
      header: t('documents.fields.correspondent'),
      width: 200,
      cell: (item) => <span className="truncate">{text(meta(item).correspondentName)}</span>,
    },
    {
      key: 'responsible',
      header: t('documents.fields.responsible'),
      width: 180,
      cell: (item) => {
        const person = meta(item).responsible as UserRef | null | undefined
        return person ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar name={person.displayName} src={person.avatarUrl} size="xs" />
            <span className="truncate">{person.displayName}</span>
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        )
      },
    },
    {
      key: 'deadline',
      header: t('documents.fields.deadline'),
      width: 110,
      sortable: sortable.includes('deadline'),
      cell: (item) =>
        typeof meta(item).deadline === 'string' ? (
          <span className={cn('tabular', meta(item).overdue ? 'text-danger' : 'text-fg-secondary')}>
            {formatDate(String(meta(item).deadline), { locale })}
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      key: 'status',
      header: t('documents.fields.status'),
      width: 170,
      sortable: sortable.includes('status'),
      cell: (item) => {
        const status = meta(item).status as DocumentStatus
        return (
          <StatusBadge
            status={DOCUMENT_STATUS_TONE[status] ?? 'draft'}
            label={t(`documents.statuses.${status}`)}
          />
        )
      },
    },
    {
      key: 'control',
      header: t('documents.fields.control'),
      width: 120,
      cell: (item) =>
        meta(item).control === 'on' ? (
          <Badge tone="purple" size="sm">
            {t('documents.controls.on')}
          </Badge>
        ) : meta(item).control === 'done' ? (
          <Badge size="sm">{t('documents.controls.done')}</Badge>
        ) : null,
    },
    {
      key: 'case',
      header: t('documents.fields.case'),
      width: 110,
      cell: (item) =>
        typeof meta(item).caseIndex === 'string' ? (
          <span className="font-mono text-xs tabular">{String(meta(item).caseIndex)}</span>
        ) : null,
    },
    {
      key: 'confidentiality',
      header: t('access.confidentiality.label'),
      width: 130,
      cell: (item) =>
        item.confidentiality && item.confidentiality !== 'public' ? (
          <Badge
            size="sm"
            tone={CONFIDENTIALITY_TONE[item.confidentiality]}
            title={t(`access.confidentiality.${item.confidentiality}`)}
          >
            {t(`access.confidentialityShort.${item.confidentiality}`)}
          </Badge>
        ) : null,
    },
  ]

  const counts: Partial<Record<Preset, number>> = {
    mine: summary?.mine,
    approval: summary?.approval,
    control: summary?.onControl,
    controlOverdue: summary?.controlOverdue,
    overdue: summary?.overdue,
    toDispatch: summary?.toDispatch,
    drafts: summary?.drafts,
  }
  const danger = (key: Preset) =>
    (key === 'overdue' && (summary?.overdue ?? 0) > 0) ||
    (key === 'controlOverdue' && (summary?.controlOverdue ?? 0) > 0)
  const openArchiveSearch = () =>
    openTab({
      kind: 'screen',
      screen: 'search',
      title: t('documents.navigator.archiveSearch'),
      icon: 'view',
      params: { types: 'document', statuses: 'filed,archived' },
      mode: 'permanent',
    })

  return (
    <section aria-label={t('documents.title')} className="flex h-full min-h-0">
      <nav
        aria-label={t('documents.navigator.title')}
        className="hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface-2 p-2 md:flex"
      >
        <NavGroup title={t('documents.navigator.views')}>
          {PRESETS.map((key) => (
            <NavButton
              key={key}
              icon={PRESET_ICONS[key]}
              label={t(`documents.navigator.presets.${key}`, { year })}
              count={counts[key]}
              danger={danger(key)}
              active={!journalId && preset === key}
              onClick={() => {
                setJournalId(null)
                setPreset(key)
              }}
            />
          ))}
        </NavGroup>
        <NavGroup title={t('documents.navigator.office')}>
          {canRegister ? (
            <NavButton
              icon={Mail}
              label={t('documents.mail.title')}
              onClick={() => openScreen('mail', t('documents.mail.title'), 'document')}
            />
          ) : null}
          <NavButton
            icon={Briefcase}
            label={t('documents.cases.title')}
            onClick={() => openScreen('cases', t('documents.cases.title'), 'case')}
          />
          <NavButton
            icon={SearchIcon}
            label={t('documents.navigator.archiveSearch')}
            onClick={openArchiveSearch}
          />
          {office?.dashboardId ? (
            <NavButton
              icon={LayoutDashboard}
              label={t('documents.navigator.dashboard')}
              onClick={() =>
                openTab({
                  kind: 'object',
                  objectId: office.dashboardId ?? '',
                  objectType: 'dashboard',
                  title: t('documents.navigator.dashboard'),
                  mode: 'permanent',
                })
              }
            />
          ) : null}
        </NavGroup>
        {journals.length > 0 ? (
          <NavGroup title={t('documents.navigator.journals')}>
            {journals.map((journal) => (
              <NavButton
                key={journal.id}
                icon={BookOpen}
                label={journal.name}
                count={journal.documentCount}
                active={journalId === journal.id}
                onClick={() => setJournalId(journal.id)}
              />
            ))}
          </NavGroup>
        ) : null}
        <NavGroup title={t('documents.navigator.directories')}>
          <NavButton
            icon={BookOpen}
            label={t('documents.journals.title')}
            onClick={() => openScreen('journals', t('documents.journals.title'), 'journal')}
          />
          <NavButton
            icon={Building2}
            label={t('documents.correspondents.title')}
            onClick={() =>
              openScreen('correspondents', t('documents.correspondents.title'), 'correspondent')
            }
          />
          <NavButton
            icon={LibraryBig}
            label={t('documents.types.title')}
            onClick={() => openScreen('types', t('documents.types.title'), 'document_type')}
          />
          <NavButton
            icon={LayoutTemplate}
            label={t('documents.templates.title')}
            onClick={() => openScreen('templates', t('documents.templates.title'), 'template')}
          />
        </NavGroup>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PanelToolbar
          left={<h1 className="text-sm font-semibold text-fg">{t('documents.title')}</h1>}
          right={
            <>
              {canRegister ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Stamp className="size-3.5" />}
                  onClick={() => openScreen('register', t('documents.register.title'), 'document')}
                >
                  {t('documents.actions.registerIncoming')}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus className="size-3.5" />}
                onClick={() => setCreating(true)}
              >
                {t('documents.actions.create')}
              </Button>
            </>
          }
        />
        <div className="min-h-0 flex-1">
          <CollectionView
            aria-label={t('documents.title')}
            rows={rows}
            getRowId={(item) => item.id}
            state={collection}
            onStateChange={(next) => {
              setCollection(next)
            }}
            fields={fields}
            sortableFields={sortable}
            columns={columns}
            modes={['table']}
            total={total}
            loading={loading}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onRowClick={(item) => openDocument(item)}
            onRowOpen={(item) => openDocument(item, true)}
            viewsMenu={
              <SavedViewsMenu
                objectType="document"
                state={collection}
                activeViewId={viewId}
                onApply={(id, next) => {
                  setViewId(id)
                  setCollection(next)
                }}
              />
            }
            renderFilterValue={renderUserFilterValue}
            describeFilterValue={describeUserFilterValue}
            empty={
              <EmptyState
                icon={<FileText />}
                title={t('documents.empty')}
                description={t(`documents.emptyHint.${journalId ? 'journal' : preset}`)}
              />
            }
          />
        </div>
      </div>
      {creating ? <CreateDocumentDialog onClose={() => setCreating(false)} /> : null}
    </section>
  )
}

function NavGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-muted">
        {title}
      </h2>
      {children}
    </div>
  )
}

function NavButton({
  icon: Icon,
  label,
  count,
  active = false,
  danger = false,
  onClick,
}: {
  icon: LucideIcon
  label: string
  count?: number
  active?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7 items-center gap-2 rounded-sm px-2 text-left text-xs transition-colors',
        active
          ? 'bg-surface font-medium text-fg shadow-sm'
          : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span className={cn('tabular text-2xs', danger ? 'text-danger' : 'text-fg-muted')}>
          {count}
        </span>
      ) : null}
    </button>
  )
}
