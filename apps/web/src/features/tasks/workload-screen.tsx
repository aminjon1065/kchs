import type { OrgUnit, TaskListItem, TaskListQuery, WorkloadPerson } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Card,
  cn,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Field,
  PanelToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { orgUnitsQuery } from '~/shared/api/queries.js'
import { tasksQuery, workloadQuery } from './queries.js'
import { STATUS_TONE_KEY } from './task-status.js'

const MINE = '__mine'
const WEEK_OPTIONS = [4, 6, 8, 12] as const

/** Что показать списком: ячейка недели, просроченные, без срока, позже, все открытые. */
type Drill =
  | { userId: string; name: string; kind: 'week'; week: string }
  | { userId: string; name: string; kind: 'overdue' | 'noDue' | 'later' | 'open' }

const pad = (value: number) => String(value).padStart(2, '0')
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00`)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Календарный день `ГГГГ-ММ-ДД` — полдень по местным часам: та же дата в любом поясе. */
const dayOf = (day: string) => `${day}T12:00:00`

/** Насыщенность ячейки по числу дел на неделе: без цвета, обычная, заметная, перегрузка. */
function loadTone(count: number): string {
  if (count === 0) return 'text-fg-muted'
  if (count <= 3) return 'bg-surface-3 text-fg'
  if (count <= 6) return 'bg-warning-subtle text-warning'
  return 'bg-danger-subtle text-danger'
}

export interface WorkloadScreenState {
  unitId?: string
  weeks?: number
}

/**
 * Нагрузка (10-tasks-projects.md §6, P3-E03 S03, ADR-0082): люди × недели —
 * открытые задачи и поручения со сроком на неделе, просрочки, без срока;
 * число в ячейке открывает список. Базово: без перетаскивания и отпусков.
 */
export function WorkloadScreen({
  tabId,
  savedState,
}: {
  tabId?: string
  savedState?: WorkloadScreenState
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)
  const [unitId, setUnitId] = useState(savedState?.unitId ?? MINE)
  const [weeks, setWeeks] = useState(savedState?.weeks ?? 6)
  const [drill, setDrill] = useState<Drill | null>(null)

  useEffect(() => {
    if (tabId) setTabState(tabId, { unitId, weeks })
  }, [tabId, unitId, weeks, setTabState])

  const { data, isLoading } = useQuery(
    workloadQuery({ weeks, ...(unitId !== MINE ? { unitId } : {}) }),
  )
  const { data: units = [] } = useQuery(orgUnitsQuery())
  const unitOptions = useMemo(
    () =>
      [...units].sort((a: OrgUnit, b: OrgUnit) =>
        (a.name.ru ?? '').localeCompare(b.name.ru ?? '', locale),
      ),
    [units, locale],
  )

  const lastWeek = data?.weeks[data.weeks.length - 1]
  const listQuery: Partial<TaskListQuery> | null = drill
    ? {
        scope: 'all',
        state: 'open',
        assigneeId: drill.userId,
        limit: 200,
        ...(drill.kind === 'week' ? { dueFrom: drill.week, dueTo: addDays(drill.week, 6) } : {}),
        ...(drill.kind === 'overdue' ? { overdue: true } : {}),
        ...(drill.kind === 'noDue' ? { noDue: true } : {}),
        ...(drill.kind === 'later' && lastWeek ? { dueFrom: addDays(lastWeek, 7) } : {}),
      }
    : null
  const list = useQuery({ ...tasksQuery(listQuery ?? {}), enabled: listQuery !== null })

  const drillLabel = (value: Drill) =>
    value.kind === 'week'
      ? t('tasks.workload.week', { date: formatDate(dayOf(value.week), { locale }) })
      : t(`tasks.workload.${value.kind}`)

  const cellButton = (person: WorkloadPerson, next: Drill, count: number, tone: string) => (
    <button
      type="button"
      disabled={count === 0}
      aria-label={t('tasks.workload.cellLabel', {
        name: person.user.displayName,
        what: drillLabel(next),
        count,
      })}
      onClick={() => setDrill(next)}
      className={cn(
        'tabular min-w-9 rounded-xs px-2 py-1 text-sm',
        count > 0 && 'hover:ring-1 hover:ring-accent',
        tone,
      )}
    >
      {count}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <Users className="size-4 text-fg-muted" aria-hidden />
            <h1 className="text-sm font-semibold text-fg">{t('tasks.workload.title')}</h1>
            {data ? (
              <span className="text-xs text-fg-muted">
                {t(`tasks.workload.scope.${data.scope}`)}
              </span>
            ) : null}
          </>
        }
        right={
          <div className="flex items-end gap-2">
            <Field label={t('tasks.control.filters.unit')}>
              <Select
                value={unitId}
                onValueChange={(next) => {
                  setUnitId(next)
                  setDrill(null)
                }}
              >
                <SelectTrigger aria-label={t('tasks.control.filters.unit')} className="h-7 w-60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MINE}>{t('tasks.workload.mine')}</SelectItem>
                  {unitOptions.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {(unit.name as Record<string, string | undefined>)[locale] ?? unit.name.ru}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('tasks.workload.weeks')}>
              <Select value={String(weeks)} onValueChange={(next) => setWeeks(Number(next))}>
                <SelectTrigger aria-label={t('tasks.workload.weeks')} className="h-7 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEK_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4">
          <Card padded={false}>
            {isLoading || !data ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-9 w-full" />
                ))}
              </div>
            ) : data.people.length === 0 ? (
              <EmptyState compact icon={<Users />} title={t('tasks.workload.empty')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label={t('tasks.workload.title')}>
                  <thead>
                    <tr className="border-b border-line bg-surface-2 text-xs text-fg-muted">
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        {t('tasks.workload.person')}
                      </th>
                      <th scope="col" className="px-2 py-2 text-center font-medium">
                        {t('tasks.workload.open')}
                      </th>
                      <th scope="col" className="px-2 py-2 text-center font-medium">
                        {t('tasks.workload.overdue')}
                      </th>
                      {data.weeks.map((week) => (
                        <th key={week} scope="col" className="px-2 py-2 text-center font-medium">
                          {formatDate(dayOf(week), { locale })}
                        </th>
                      ))}
                      <th scope="col" className="px-2 py-2 text-center font-medium">
                        {t('tasks.workload.later')}
                      </th>
                      <th scope="col" className="px-2 py-2 text-center font-medium">
                        {t('tasks.workload.noDue')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.people.map((person) => {
                      const base = { userId: person.user.id, name: person.user.displayName }
                      return (
                        <tr key={person.user.id} className="border-b border-line last:border-0">
                          <th scope="row" className="px-3 py-1.5 text-left font-normal">
                            <span className="flex items-center gap-2">
                              <Avatar
                                name={person.user.displayName}
                                src={person.user.avatarUrl}
                                size="sm"
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-fg">
                                  {person.user.displayName}
                                </span>
                                {person.user.unitName ? (
                                  <span className="block truncate text-2xs text-fg-muted">
                                    {person.user.unitName}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </th>
                          <td className="px-2 text-center">
                            {cellButton(person, { ...base, kind: 'open' }, person.open, 'text-fg')}
                          </td>
                          <td className="px-2 text-center">
                            {cellButton(
                              person,
                              { ...base, kind: 'overdue' },
                              person.overdue,
                              person.overdue > 0 ? 'bg-danger-subtle text-danger' : 'text-fg-muted',
                            )}
                          </td>
                          {person.cells.map((cell) => (
                            <td key={cell.week} className="px-2 text-center">
                              {cellButton(
                                person,
                                { ...base, kind: 'week', week: cell.week },
                                cell.total,
                                loadTone(cell.total),
                              )}
                            </td>
                          ))}
                          <td className="px-2 text-center">
                            {cellButton(
                              person,
                              { ...base, kind: 'later' },
                              person.later,
                              'text-fg-secondary',
                            )}
                          </td>
                          <td className="px-2 text-center">
                            {cellButton(
                              person,
                              { ...base, kind: 'noDue' },
                              person.noDue,
                              'text-fg-secondary',
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {drill ? (
            <Card
              title={t('tasks.workload.listTitle', { name: drill.name, what: drillLabel(drill) })}
              padded={false}
            >
              <DrillList
                items={list.data?.items ?? []}
                loading={list.isLoading}
                onOpen={(item) =>
                  openTab({
                    kind: 'object',
                    objectId: item.id,
                    objectType: 'task',
                    title: item.title,
                    mode: 'permanent',
                  })
                }
              />
            </Card>
          ) : (
            <p className="text-xs text-fg-muted">{t('tasks.workload.hint')}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function DrillList({
  items,
  loading,
  onOpen,
}: {
  items: TaskListItem[]
  loading: boolean
  onOpen: (item: TaskListItem) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const columns: Array<DataTableColumn<TaskListItem>> = [
    {
      key: 'title',
      header: t('tasks.fields.title'),
      minWidth: 260,
      cell: (item) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-fg-muted">{item.key}</span>
          {item.kind === 'instruction' ? (
            <Badge tone="purple" size="sm">
              {t('tasks.kinds.instruction')}
            </Badge>
          ) : null}
          <span className="truncate">{item.title}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('tasks.fields.status'),
      width: 170,
      cell: (item) => (
        <StatusBadge
          status={STATUS_TONE_KEY[item.status]}
          label={t(`tasks.statuses.${item.status}`)}
        />
      ),
    },
    {
      key: 'due',
      header: t('tasks.fields.due'),
      width: 120,
      cell: (item) =>
        item.dueAt ? (
          <span className={cn('tabular', item.overdue ? 'text-danger' : 'text-fg-secondary')}>
            {formatDate(item.dueAt, { locale })}
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
  ]
  if (!loading && items.length === 0) return <EmptyState compact title={t('tasks.empty')} />
  return (
    <div className="h-80">
      <DataTable
        aria-label={t('tasks.workload.list')}
        rows={items}
        getRowId={(item) => item.id}
        columns={columns}
        loading={loading}
        onRowClick={onOpen}
        onRowOpen={onOpen}
      />
    </div>
  )
}
