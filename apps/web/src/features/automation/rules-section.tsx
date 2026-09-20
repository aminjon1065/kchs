import type { RuleDefinition, RuleListItem, RuleTemplate } from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import { localizedText } from '@kchs/i18n'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Zap } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError } from '~/shared/api/client.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { automationApi, automationKeys, rulesQuery, ruleTemplatesQuery } from './queries.js'

/**
 * «Правила автоматизации» в консоли (14-automation-integrations.md §1,
 * ADR-0096): список по пространствам с включением, создание из шаблона или с
 * нуля — и конструктор во вкладке. Доступно со способностью `automation.manage`.
 */
export function AutomationRulesSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const client = useQueryClient()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [spaceId, setSpaceId] = useState('all')
  const [triggerKind, setTriggerKind] = useState('all')
  const [creating, setCreating] = useState(false)
  const q = useDebouncedValue(search, 300)

  const { data, isLoading } = useQuery(
    rulesQuery({
      ...(q ? { q } : {}),
      ...(spaceId === 'all' ? {} : { spaceId }),
      ...(triggerKind === 'all' ? {} : { triggerKind: triggerKind as 'event' }),
    }),
  )
  const { data: spaces = [] } = useQuery(spacesQuery())

  const open = (rule: { id: string; name: RuleListItem['name'] }) =>
    openTab({
      kind: 'screen',
      screen: 'rule-designer',
      params: { id: rule.id },
      title: localizedText(rule.name, locale),
      icon: 'zap',
      mode: 'permanent',
    })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      automationApi.setEnabled(id, enabled),
    onSuccess: async (rule) => {
      toast.show({
        title: rule.enabled ? t('automation.toggle.enabled') : t('automation.toggle.disabled'),
        tone: 'success',
      })
      await client.invalidateQueries({ queryKey: automationKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const columns: Array<DataTableColumn<RuleListItem>> = [
    {
      key: 'name',
      header: t('automation.columns.name'),
      width: 260,
      cell: (row) => (
        <span className="truncate font-medium">{localizedText(row.name, locale)}</span>
      ),
    },
    {
      key: 'trigger',
      header: t('automation.columns.trigger'),
      width: 200,
      cell: (row) => (
        <span className="flex items-center gap-2">
          <Badge tone="neutral">{t(`automation.triggers.${row.triggerKind}`)}</Badge>
          <code className="truncate font-mono text-xs">{row.triggerSummary}</code>
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('automation.columns.actions'),
      width: 180,
      cell: (row) => (
        <span className="truncate text-xs text-fg-secondary">
          {row.actionTypes.map((type) => t(`automation.actions.${type}`)).join(' → ')}
        </span>
      ),
    },
    {
      key: 'runs',
      header: t('automation.columns.runs'),
      width: 130,
      cell: (row) =>
        row.stats.runs === 0 ? (
          '—'
        ) : (
          <span className="flex items-center gap-1 text-xs">
            <span>{row.stats.runs}</span>
            {row.stats.failures > 0 ? (
              <Badge tone="danger" size="sm">
                {row.stats.failures}
              </Badge>
            ) : null}
          </span>
        ),
    },
    {
      key: 'state',
      header: t('automation.columns.state'),
      width: 110,
      cell: (row) => (
        <Switch
          checked={row.enabled}
          aria-label={t('automation.fields.enabled')}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
        />
      ),
    },
    {
      key: 'updated',
      header: t('automation.columns.updated'),
      width: 130,
      cell: (row) => formatRelativeTime(row.updatedAt, { locale }),
    },
  ]

  const items = data?.items ?? []

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-fg">{t('automation.title')}</h2>
          <p className="text-sm text-fg-secondary">{t('automation.hint')}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('automation.create')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('automation.search')}
          className="w-64"
        />
        <Select value={spaceId} onValueChange={setSpaceId}>
          <SelectTrigger aria-label={t('automation.space')} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('automation.allSpaces')}</SelectItem>
            {spaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={triggerKind} onValueChange={setTriggerKind}>
          <SelectTrigger aria-label={t('automation.fields.trigger')} className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('automation.allTriggers')}</SelectItem>
            {(['event', 'schedule', 'webhook', 'manual', 'metric'] as const).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`automation.triggers.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Zap className="size-5" />}
          title={t('automation.empty.title')}
          description={t('automation.empty.description')}
        />
      ) : (
        <div className="h-[28rem] min-h-0">
          <DataTable
            rows={items}
            getRowId={(row) => row.id}
            columns={columns}
            onRowClick={open}
            onRowOpen={open}
          />
        </div>
      )}

      <CreateRuleDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id, name) => {
          setCreating(false)
          open({ id, name: { ru: name } })
        }}
      />
    </div>
  )
}

/** Новое правило: название, пространство и шаблон из галереи или пустое. */
function CreateRuleDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string, name: string) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const [name, setName] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [template, setTemplate] = useState<RuleTemplate | null>(null)
  const { data: spaces = [] } = useQuery(spacesQuery())
  const { data: templates = [] } = useQuery(ruleTemplatesQuery())

  const create = useMutation({
    mutationFn: () => {
      const base: RuleDefinition = template
        ? template.definition
        : {
            version: 1,
            name: { ru: name },
            description: null,
            enabled: false,
            runAs: null,
            trigger: { kind: 'event', type: 'object.created', filter: {} },
            conditions: null,
            actions: [
              { type: 'notify', to: [], text: '', channels: ['app'], object: '{{object.id}}' },
            ],
            limits: { maxRunsPerHour: 100, dedupeKey: null, dedupeWindowMinutes: 60 },
          }
      return automationApi.create({
        spaceId,
        definition: { ...base, name: { ru: name }, enabled: false },
      })
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: automationKeys.all })
      toast.show({ title: t('automation.designer.created'), tone: 'success' })
      onCreated(result.id, name)
      setName('')
      setTemplate(null)
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('automation.createTitle')}
        size="lg"
        footer={
          <Button
            variant="primary"
            disabled={name.trim().length === 0 || spaceId.length === 0}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('automation.create')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('automation.name')} htmlFor={nameId} required>
            <Input
              id={nameId}
              value={name}
              placeholder={t('automation.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('automation.space')} required>
            <Select value={spaceId} onValueChange={setSpaceId}>
              <SelectTrigger aria-label={t('automation.space')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('automation.templates.title')}>
            <div className="grid gap-2 md:grid-cols-2">
              <TemplateCard
                title={t('automation.blank')}
                description={t('automation.empty.description')}
                selected={template === null}
                onSelect={() => setTemplate(null)}
              />
              {templates.map((item) => (
                <TemplateCard
                  key={item.key}
                  title={localizedText(item.name, locale)}
                  description={localizedText(item.description, locale)}
                  badge={t(`automation.templates.categories.${item.category}`)}
                  selected={template?.key === item.key}
                  onSelect={() => {
                    setTemplate(item)
                    if (name.trim().length === 0) setName(localizedText(item.name, locale))
                  }}
                />
              ))}
            </div>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TemplateCard({
  title,
  description,
  badge,
  selected,
  onSelect,
}: {
  title: string
  description: string
  badge?: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Card
      className={`cursor-pointer p-3 transition-colors ${selected ? 'border-accent' : ''}`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-fg">{title}</span>
        {badge ? <Badge tone="neutral">{badge}</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-fg-secondary">{description}</p>
    </Card>
  )
}
