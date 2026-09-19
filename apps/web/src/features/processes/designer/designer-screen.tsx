import { localizedText } from '@kchs/i18n'
import type {
  DefinitionIssue,
  ProcessDefinitionDetails,
  ProcessDefinitionVersion,
  ProcessDraftSaved,
  ProcessValidation,
} from '@kchs/process'
import {
  AlertDialog,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorState,
  IconButton,
  NoAccessState,
  PanelToolbar,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, History, MoreHorizontal, Save, Send, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { rolesQuery } from '~/shared/api/queries.js'
import { allAssigneeExpressions, principalKeysOf } from '../assignees.js'
import type { Definition } from '../model.js'
import {
  principalRefsQuery,
  processCatalogQuery,
  processDefinitionQuery,
  processKeys,
} from '../queries.js'
import { type DesignerContextValue, DesignerProvider, type Selection } from './context.js'
import { FlowView } from './flow-view.js'
import { IssuesPanel, JsonView, VersionsDialog } from './panels.js'
import { PreviewPanel } from './preview-panel.js'
import { RouteSettings } from './route-settings.js'
import { StepInspector } from './step-inspector.js'

type Panel = 'step' | 'route' | 'issues' | 'preview'

/** Проблемы из ответа сервера с ошибкой (публикация, сохранение с ошибкой формы). */
function issuesOf(error: unknown): DefinitionIssue[] | null {
  if (!(error instanceof ApiError)) return null
  const issues = error.problem.data?.issues
  return Array.isArray(issues) ? (issues as DefinitionIssue[]) : null
}

/**
 * Конструктор маршрутов (P3-E01 S03, 08-documents.md §4, ADR-0087): схема
 * шагов с вложенными параллельными группами, инспектор шага и настроек
 * маршрута, проверка сервером на лету, предпросмотр назначений на примере
 * объекта, JSON, черновик, публикация и история версий.
 */
export default function DesignerScreen({
  definitionKey,
  tabId,
}: {
  definitionKey: string
  tabId: string
}) {
  const t = useT()
  const details = useQuery(processDefinitionQuery(definitionKey))
  if (details.isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }
  if (details.error || !details.data) {
    if (details.error instanceof ApiError && details.error.status === 403) return <NoAccessState />
    return (
      <ErrorState
        title={t('processDesigner.loadFailed')}
        description={details.error instanceof ApiError ? details.error.message : undefined}
        onRetry={() => void details.refetch()}
      />
    )
  }
  return <Designer details={details.data} tabId={tabId} />
}

function Designer({ details, tabId }: { details: ProcessDefinitionDetails; tabId: string }) {
  const t = useT()
  const toast = useToast()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const setTabDirty = useWorkspace((s) => s.setTabDirty)
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const current = details.draft ?? details.published
  const [baseline, setBaseline] = useState<Definition | null>(current?.definition ?? null)
  const [definition, setDefinition] = useState<Definition | null>(current?.definition ?? null)
  const [issues, setIssues] = useState<DefinitionIssue[]>([])
  const [checking, setChecking] = useState(false)
  const [selection, setSelection] = useState<Selection>({ kind: 'route', section: 'general' })
  const [panel, setPanel] = useState<Panel>('route')
  const [view, setView] = useState<'flow' | 'json'>('flow')
  const [confirm, setConfirm] = useState<'publish' | 'discard' | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)

  const catalog = useQuery(processCatalogQuery())
  const roles = useQuery(rolesQuery())
  const principalKeys = useMemo(
    () => principalKeysOf(allAssigneeExpressions(definition)),
    [definition],
  )
  const principals = useQuery(principalRefsQuery(principalKeys))

  const dirty = useMemo(
    () => JSON.stringify(definition) !== JSON.stringify(baseline),
    [definition, baseline],
  )
  useEffect(() => setTabDirty(tabId, dirty), [dirty, setTabDirty, tabId])
  const title = definition ? localizedText(definition.name, locale) : details.key
  useEffect(() => {
    if (title.trim()) setTabTitle(tabId, title)
  }, [setTabTitle, tabId, title])

  // Проверка сервером на лету: последний ответ побеждает
  const generation = useRef(0)
  useEffect(() => {
    if (!definition) return
    const ticket = ++generation.current
    setChecking(true)
    const timer = setTimeout(() => {
      http
        .post<ProcessValidation>('/process-definitions/validate', { definition })
        .then((result) => {
          if (ticket === generation.current) setIssues(result.issues)
        })
        .catch(() => undefined)
        .finally(() => {
          if (ticket === generation.current) setChecking(false)
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [definition])

  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: processKeys.all })
  }, [client])

  const adopt = (saved: ProcessDefinitionVersion) => {
    setBaseline(saved.definition)
    setDefinition(saved.definition)
  }

  const saveDraft = async (): Promise<ProcessDraftSaved> => {
    const saved = await http.put<ProcessDraftSaved>(`/process-definitions/${details.key}/draft`, {
      definition,
    })
    adopt(saved.version)
    setIssues(saved.issues)
    return saved
  }

  const save = useMutation({
    mutationFn: saveDraft,
    onSuccess: (saved) => {
      toast.show({
        title: t('processDesigner.toasts.saved', { version: saved.version.version }),
        tone: 'success',
      })
      void refresh()
    },
    onError: (error) => {
      const found = issuesOf(error)
      if (found) setIssues(found)
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    },
  })

  const publish = useMutation({
    mutationFn: async () => {
      if (dirty || !details.draft) await saveDraft()
      return http.post<ProcessDefinitionVersion>(`/process-definitions/${details.key}/publish`)
    },
    onSuccess: (published) => {
      adopt(published)
      setConfirm(null)
      toast.show({
        title: t('processDesigner.toasts.published', { version: published.version }),
        tone: 'success',
      })
      void refresh()
    },
    onError: (error) => {
      setConfirm(null)
      const found = issuesOf(error)
      if (found) {
        setIssues(found)
        setPanel('issues')
      }
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    },
  })

  const discard = useMutation({
    mutationFn: () => http.delete(`/process-definitions/${details.key}/draft`),
    onSuccess: () => {
      setConfirm(null)
      if (details.published) adopt(details.published)
      toast.show({ title: t('processDesigner.toasts.discarded'), tone: 'info' })
      void refresh()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const loadVersion = async (version: number) => {
    try {
      const loaded = await http.get<ProcessDefinitionVersion>(
        `/process-definitions/${details.key}/versions/${version}`,
      )
      setDefinition(loaded.definition)
      setVersionsOpen(false)
      toast.show({ title: t('processDesigner.versions.loaded', { version }), tone: 'info' })
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    }
  }

  // На узком экране свойства — под схемой: выбранный шаг прокручивает к ним
  const panelRef = useRef<HTMLDivElement>(null)
  const select = useCallback((next: Selection) => {
    setSelection(next)
    setPanel(next.kind === 'step' ? 'step' : 'route')
    if (!window.matchMedia('(min-width: 1024px)').matches) {
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'start' }))
    }
  }, [])

  const update = useCallback((change: (value: Definition) => Definition) => {
    setDefinition((value) => (value ? change(value) : value))
  }, [])

  const context = useMemo<DesignerContextValue | null>(
    () =>
      definition
        ? {
            definition,
            update,
            issues,
            selection,
            select,
            catalog: catalog.data,
            roles: roles.data ?? [],
            principals: principals.data ?? new Map(),
            readOnly: false,
          }
        : null,
    [definition, update, issues, selection, select, catalog.data, roles.data, principals.data],
  )

  if (!definition || !context) {
    return <ErrorState title={t('processDesigner.loadFailed')} />
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length
  const nextVersion = details.draft?.version ?? (details.published?.version ?? 0) + 1
  const status = details.draft
    ? t('processDesigner.state.draft', { version: details.draft.version })
    : details.published
      ? t('processDesigner.state.published', { version: details.published.version })
      : null

  return (
    <DesignerProvider value={context}>
      <div className="flex h-full min-h-0 flex-col">
        <PanelToolbar
          left={
            <>
              <h1 className="hidden truncate text-sm font-semibold text-fg sm:block">{title}</h1>
              {status ? (
                <Badge
                  tone={details.draft ? 'warning' : 'success'}
                  className="hidden md:inline-flex"
                >
                  {status}
                </Badge>
              ) : null}
              {dirty ? (
                <Badge tone="accent" className="hidden lg:inline-flex">
                  {t('processDesigner.state.unsaved', { version: nextVersion })}
                </Badge>
              ) : null}
            </>
          }
          right={
            <>
              <Button
                size="sm"
                variant={dirty ? 'primary' : 'secondary'}
                disabled={!dirty}
                loading={save.isPending}
                onClick={() => save.mutate()}
                aria-label={t('processDesigner.actions.save')}
              >
                <Save className="size-3.5" />
                <span className="hidden sm:inline">{t('processDesigner.actions.save')}</span>
              </Button>
              <Button
                size="sm"
                disabled={errors > 0 || (!dirty && !details.draft)}
                onClick={() => setConfirm('publish')}
                aria-label={t('processDesigner.actions.publish')}
              >
                <Send className="size-3.5" />
                <span className="hidden sm:inline">{t('processDesigner.actions.publish')}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label={t('processDesigner.actions.more')}>
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={<History className="size-3.5" />}
                    onSelect={() => setVersionsOpen(true)}
                  >
                    {t('processDesigner.actions.versions')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<CheckCircle2 className="size-3.5" />}
                    onSelect={() => setPanel('issues')}
                  >
                    {t('processDesigner.actions.validate')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    danger
                    icon={<Trash2 className="size-3.5" />}
                    disabled={!details.draft || !details.published}
                    onSelect={() => setConfirm('discard')}
                  >
                    {t('processDesigner.actions.discard')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />
        {/* Узкий экран: схема и свойства одной прокруткой; широкий — рядом, прокрутка у каждой */}
        <div className="min-h-0 flex-1 overflow-y-auto lg:flex lg:overflow-hidden">
          <Tabs
            value={view}
            onValueChange={(next) => setView(next as 'flow' | 'json')}
            className="flex min-w-0 flex-col bg-canvas lg:min-h-0 lg:flex-1 lg:border-r lg:border-line"
          >
            <TabsList aria-label={t('processDesigner.views.label')} className="shrink-0 px-2">
              <TabsTrigger value="flow">{t('processDesigner.views.flow')}</TabsTrigger>
              <TabsTrigger value="json">{t('processDesigner.views.json')}</TabsTrigger>
            </TabsList>
            <TabsContent value="flow" className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <FlowView />
            </TabsContent>
            <TabsContent value="json" className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <JsonView onApply={(next) => setDefinition(next)} />
            </TabsContent>
          </Tabs>
          <Tabs
            ref={panelRef}
            value={panel}
            onValueChange={(next) => setPanel(next as Panel)}
            className="flex flex-col border-t border-line bg-surface lg:min-h-0 lg:w-[26rem] lg:shrink-0 lg:border-t-0"
          >
            <TabsList
              aria-label={t('processDesigner.panels.label')}
              className="shrink-0 overflow-x-auto px-2"
            >
              <TabsTrigger value="step">{t('processDesigner.panels.step')}</TabsTrigger>
              <TabsTrigger value="route">{t('processDesigner.panels.route')}</TabsTrigger>
              <TabsTrigger value="issues">
                {t('processDesigner.panels.issues')}
                {errors > 0 ? (
                  <Badge tone="danger" size="sm">
                    {errors}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="preview">{t('processDesigner.panels.preview')}</TabsTrigger>
            </TabsList>
            <TabsContent value="step" className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <StepInspector stepKey={selection.kind === 'step' ? selection.key : ''} />
            </TabsContent>
            <TabsContent value="route" className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <RouteSettings />
            </TabsContent>
            <TabsContent value="issues" className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <IssuesPanel checking={checking} />
            </TabsContent>
            <TabsContent value="preview" className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <PreviewPanel />
            </TabsContent>
          </Tabs>
        </div>
      </div>
      <AlertDialog
        open={confirm === 'publish'}
        onOpenChange={(open) => setConfirm(open ? 'publish' : null)}
        title={t('processDesigner.confirmPublish.title', { version: nextVersion })}
        description={t('processDesigner.confirmPublish.body')}
        confirmLabel={t('processDesigner.confirmPublish.confirm')}
        loading={publish.isPending}
        onConfirm={() => publish.mutate()}
      />
      <AlertDialog
        open={confirm === 'discard'}
        onOpenChange={(open) => setConfirm(open ? 'discard' : null)}
        title={t('processDesigner.confirmDiscard.title')}
        description={t('processDesigner.confirmDiscard.body')}
        confirmLabel={t('processDesigner.confirmDiscard.confirm')}
        destructive
        loading={discard.isPending}
        onConfirm={() => discard.mutate()}
      />
      <VersionsDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        details={details}
        onLoad={(version) => void loadVersion(version)}
      />
    </DesignerProvider>
  )
}
