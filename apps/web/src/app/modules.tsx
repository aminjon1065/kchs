import { Skeleton } from '@kchs/ui'
import { lazy, Suspense } from 'react'
import { AdminScreen } from '~/features/admin/admin-screen.js'
import { AssistantScreen } from '~/features/assistant/assistant-screen.js'
import { CalendarScreen, type CalendarScreenState } from '~/features/calendar/calendar-screen.js'
import { CalendarView } from '~/features/calendar/calendar-view.js'
import { EventView } from '~/features/calendar/event-view.js'
import { ChatsScreen, type ChatsScreenState } from '~/features/chat/chats-screen.js'
import { AnalysisView } from '~/features/data/analysis-view.js'
import { ChartView } from '~/features/data/chart-view.js'
import { DashboardView } from '~/features/data/dashboard-view.js'
import { DataCatalogScreen } from '~/features/data/data-catalog-screen.js'
import { DatasetView } from '~/features/data/dataset-view.js'
import { ExploreScreen } from '~/features/data/explore-screen.js'
import { MetricView } from '~/features/data/metric-view.js'
import { type SavedSqlLab, SqlLabScreen } from '~/features/data/sql-lab-screen.js'
import { DocumentAssistant } from '~/features/documents/assist/document-assistant.js'
import { DocumentContextSection, DocumentView } from '~/features/documents/card/document-view.js'
import { CasesDirectory } from '~/features/documents/directories/cases-directory.js'
import { CorrespondentsDirectory } from '~/features/documents/directories/correspondents-directory.js'
import { JournalsDirectory } from '~/features/documents/directories/journals-directory.js'
import { TemplatesDirectory } from '~/features/documents/directories/templates-directory.js'
import { TypesDirectory } from '~/features/documents/directories/types-directory.js'
import { DocumentsScreen } from '~/features/documents/documents-screen.js'
import { FilesScreen } from '~/features/files/files-screen.js'
import { LayerView } from '~/features/gis/layer-view.js'
import { MapStudio, type MapTabState } from '~/features/gis/map-studio.js'
import { MapsScreen } from '~/features/gis/maps-screen.js'
import { TerritoriesScreen } from '~/features/gis/territories-screen.js'
import { TerritoryView } from '~/features/gis/territory-view.js'
import { HomeScreen } from '~/features/home/home-screen.js'
import { InboxScreen } from '~/features/inbox/inbox-screen.js'
import { KnowledgeScreen } from '~/features/knowledge/knowledge-screen.js'
import { MeetingsScreen } from '~/features/meetings/meetings-screen.js'
import { NotificationsScreen } from '~/features/notifications/notifications-screen.js'
import { FileView } from '~/features/objects/file-view.js'
import { FolderView } from '~/features/objects/folder-view.js'
import { TrashScreen } from '~/features/objects/trash-screen.js'
import { ProfileScreen } from '~/features/profile/profile-screen.js'
import { SearchScreen } from '~/features/search/search-screen.js'
import { SpaceScreen } from '~/features/spaces/space-screen.js'
import { SpacesScreen } from '~/features/spaces/spaces-screen.js'
import { ControlScreen, type ControlScreenState } from '~/features/tasks/control-screen.js'
import { ProjectView } from '~/features/tasks/project-view.js'
import { TaskView } from '~/features/tasks/task-view.js'
import { TasksScreen, type TasksScreenState } from '~/features/tasks/tasks-screen.js'
import { WorkloadScreen, type WorkloadScreenState } from '~/features/tasks/workload-screen.js'
import { registerObjectView, registerScreen } from './workspace/registry.js'

/** Формы сбора данных и алерты (ADR-0103, ADR-0104) — отдельным чанком. */
const FormsScreen = lazy(() =>
  import('~/features/forms/forms-screen.js').then((module) => ({ default: module.FormsScreen })),
)
const FormView = lazy(() =>
  import('~/features/forms/form-view.js').then((module) => ({ default: module.FormView })),
)
const AlertsScreen = lazy(() =>
  import('~/features/alerts/alerts-screen.js').then((module) => ({ default: module.AlertsScreen })),
)
const AlertView = lazy(() =>
  import('~/features/alerts/alert-view.js').then((module) => ({ default: module.AlertView })),
)

/** Заглушка ленивого экрана: та же, что у конструкторов. */
function LazyFallback() {
  return (
    <div className="flex flex-col gap-3 p-6">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

/** Тетрадь — отдельным чанком: Tiptap, Yjs и клиент совместной правки не в оболочке. */
const NotebookView = lazy(() => import('~/features/notebooks/notebook-view.js'))
/** Отчёт — тоже отдельным чанком: тот же совместный документ, что у тетради (ADR-0078). */
const ReportView = lazy(() => import('~/features/reports/report-view.js'))
/** Встреча и её протокол — отдельным чанком: Tiptap и клиент совместной правки (ADR-0093). */
const MeetingView = lazy(() => import('~/features/meetings/meeting-view.js'))
const ProtocolView = lazy(() => import('~/features/meetings/protocol/protocol-view.js'))
/** Страница базы знаний — отдельным чанком: Tiptap и клиент совместной правки (ADR-0095). */
const PageView = lazy(() => import('~/features/knowledge/page-view.js'))
/** Конструктор маршрутов — отдельным чанком: нужен только администратору маршрутов (ADR-0087). */
const ProcessDesigner = lazy(() => import('~/features/processes/designer/designer-screen.js'))
const RuleDesigner = lazy(() => import('~/features/automation/designer/rule-designer.js'))
/** Запись встречи — отдельным чанком: плеер и расшифровка нужны не всем (ADR-0092). */
const RecordingView = lazy(() => import('~/features/meetings/recording/recording-view.js'))

let registered = false

/** Регистрация экранов и представлений объектов. */
export function registerModules(): void {
  if (registered) return
  registered = true

  registerScreen({
    key: 'home',
    titleKey: 'shell.rail.home',
    icon: 'home',
    render: () => <HomeScreen />,
  })
  registerScreen({
    key: 'assistant',
    titleKey: 'shell.rail.assistant',
    icon: 'assistant',
    render: () => <AssistantScreen />,
  })
  registerScreen({
    key: 'knowledge',
    titleKey: 'shell.rail.knowledge',
    icon: 'page',
    render: (tab) => <KnowledgeScreen spaceId={tab.params.spaceId} />,
  })
  registerScreen({
    key: 'inbox',
    titleKey: 'shell.rail.inbox',
    icon: 'inbox',
    render: () => <InboxScreen />,
  })
  registerScreen({
    key: 'notifications',
    titleKey: 'shell.rail.notifications',
    icon: 'notification',
    render: () => <NotificationsScreen />,
  })
  registerScreen({
    key: 'files',
    titleKey: 'shell.rail.files',
    icon: 'folder',
    render: (tab) => (
      <FilesScreen
        spaceId={tab.params.spaceId}
        tabId={tab.id}
        savedState={tab.state as Parameters<typeof FilesScreen>[0]['savedState']}
      />
    ),
  })
  registerScreen({
    key: 'data',
    titleKey: 'shell.rail.data',
    icon: 'dataset',
    render: (tab) => (
      <DataCatalogScreen
        spaceId={tab.params.spaceId}
        tabId={tab.id}
        savedState={tab.state as Parameters<typeof DataCatalogScreen>[0]['savedState']}
      />
    ),
  })
  registerScreen({
    key: 'explore',
    titleKey: 'data.explore.title',
    icon: 'query',
    render: (tab) => (
      <ExploreScreen
        datasetId={tab.params.datasetId ?? ''}
        tabId={tab.id}
        savedState={tab.state as Parameters<typeof ExploreScreen>[0]['savedState']}
      />
    ),
  })
  registerScreen({
    key: 'sql',
    titleKey: 'data.sql.title',
    icon: 'query',
    render: (tab) => <SqlLabScreen tabId={tab.id} savedState={tab.state as SavedSqlLab} />,
  })
  registerScreen({
    key: 'tasks',
    titleKey: 'shell.rail.tasks',
    icon: 'task',
    render: (tab) => <TasksScreen tabId={tab.id} savedState={tab.state as TasksScreenState} />,
  })
  registerScreen({
    key: 'control',
    titleKey: 'tasks.control.title',
    icon: 'task',
    render: (tab) => <ControlScreen tabId={tab.id} savedState={tab.state as ControlScreenState} />,
  })
  registerScreen({
    key: 'workload',
    titleKey: 'tasks.workload.title',
    icon: 'user',
    render: (tab) => (
      <WorkloadScreen tabId={tab.id} savedState={tab.state as WorkloadScreenState} />
    ),
  })
  registerScreen({
    key: 'chats',
    titleKey: 'shell.rail.chats',
    icon: 'conversation',
    render: (tab) => (
      <ChatsScreen
        tabId={tab.id}
        savedState={tab.state as ChatsScreenState}
        initialConversationId={tab.params.conversation}
      />
    ),
  })
  registerScreen({
    key: 'calendar',
    titleKey: 'shell.rail.calendar',
    icon: 'calendar',
    render: (tab) => (
      <CalendarScreen tabId={tab.id} savedState={tab.state as CalendarScreenState} />
    ),
  })
  registerObjectView({
    type: 'calendar',
    render: (tab) => <CalendarView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({
    type: 'event',
    render: (tab) => <EventView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({
    type: 'recording',
    render: (tab) => (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <RecordingView objectId={tab.objectId!} tabId={tab.id} />
      </Suspense>
    ),
  })
  registerScreen({
    key: 'meetings',
    titleKey: 'shell.rail.meetings',
    icon: 'meeting',
    render: () => <MeetingsScreen />,
  })
  registerScreen({
    key: 'search',
    titleKey: 'shell.rail.search',
    icon: 'view',
    render: (tab) => (
      <SearchScreen
        initialQuery={tab.params.q ?? ''}
        initialTypes={tab.params.types?.split(',').filter(Boolean) ?? []}
        initialStatuses={tab.params.statuses?.split(',').filter(Boolean) ?? []}
      />
    ),
  })
  registerScreen({
    key: 'spaces',
    titleKey: 'spaces.title',
    icon: 'space',
    render: () => <SpacesScreen />,
  })
  registerScreen({
    key: 'space',
    titleKey: 'objects.types.space',
    icon: 'space',
    render: (tab) => <SpaceScreen spaceId={tab.params.spaceId ?? ''} />,
  })
  registerScreen({
    key: 'admin',
    titleKey: 'shell.rail.admin',
    icon: 'role',
    render: () => <AdminScreen />,
  })
  registerScreen({
    key: 'profile',
    titleKey: 'shell.rail.profile',
    icon: 'user',
    render: () => <ProfileScreen />,
  })
  registerScreen({
    key: 'process-designer',
    titleKey: 'processDesigner.screenTitle',
    icon: 'route',
    render: (tab) => (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <ProcessDesigner definitionKey={tab.params.key ?? ''} tabId={tab.id} />
      </Suspense>
    ),
  })
  registerScreen({
    key: 'rule-designer',
    titleKey: 'automation.title',
    icon: 'zap',
    render: (tab) => (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <RuleDesigner ruleId={tab.params.id ?? ''} />
      </Suspense>
    ),
  })
  registerScreen({
    key: 'trash',
    titleKey: 'objects.trash.title',
    icon: 'folder',
    render: () => <TrashScreen />,
  })

  registerObjectView({
    type: 'file',
    render: (tab) => <FileView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({ type: 'folder', render: (tab) => <FolderView objectId={tab.objectId!} /> })
  registerObjectView({
    type: 'dashboard',
    render: (tab) => <DashboardView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({
    type: 'chart',
    render: (tab) => <ChartView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({
    type: 'page',
    render: (tab) => (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <PageView objectId={tab.objectId!} tabId={tab.id} />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'notebook',
    render: (tab) => (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <NotebookView objectId={tab.objectId!} tabId={tab.id} />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'report',
    render: (tab) => (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <ReportView objectId={tab.objectId!} tabId={tab.id} />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'meeting',
    render: (tab) => (
      <Suspense fallback={<Skeleton className="m-4 h-40" />}>
        <MeetingView objectId={tab.objectId!} tabId={tab.id} />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'protocol',
    render: (tab) => (
      <Suspense fallback={<Skeleton className="m-4 h-40" />}>
        <ProtocolView objectId={tab.objectId!} tabId={tab.id} />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'metric',
    render: (tab) => <MetricView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerScreen({
    key: 'forms',
    titleKey: 'forms.title',
    icon: 'form',
    render: () => (
      <Suspense fallback={<LazyFallback />}>
        <FormsScreen />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'form',
    render: (tab) => (
      <Suspense fallback={<LazyFallback />}>
        <FormView objectId={tab.objectId!} />
      </Suspense>
    ),
  })
  registerScreen({
    key: 'alerts',
    titleKey: 'alerts.title',
    icon: 'alert',
    render: () => (
      <Suspense fallback={<LazyFallback />}>
        <AlertsScreen />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'alert',
    render: (tab) => (
      <Suspense fallback={<LazyFallback />}>
        <AlertView objectId={tab.objectId!} />
      </Suspense>
    ),
  })
  registerObjectView({
    type: 'dataset',
    render: (tab) => <DatasetView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({
    type: 'analysis',
    render: (tab) => <AnalysisView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({
    type: 'task',
    render: (tab) => <TaskView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({
    type: 'project',
    render: (tab) => (
      <ProjectView
        objectId={tab.objectId!}
        tabId={tab.id}
        savedState={tab.state as TasksScreenState}
      />
    ),
  })
  registerObjectView({ type: 'space', render: (tab) => <SpaceScreen spaceId={tab.objectId!} /> })
  registerScreen({
    key: 'territories',
    titleKey: 'gis.territories.title',
    icon: 'territory',
    render: () => <TerritoriesScreen />,
  })
  registerObjectView({
    type: 'territory',
    render: (tab) => <TerritoryView objectId={tab.objectId!} />,
  })
  registerScreen({
    key: 'maps',
    titleKey: 'shell.rail.maps',
    icon: 'map',
    render: (tab) => (
      <MapsScreen
        tabId={tab.id}
        savedState={tab.state as Parameters<typeof MapsScreen>[0]['savedState']}
      />
    ),
  })
  registerObjectView({
    type: 'map',
    render: (tab) => (
      <MapStudio objectId={tab.objectId!} tabId={tab.id} savedState={tab.state as MapTabState} />
    ),
  })
  registerScreen({
    key: 'documents',
    titleKey: 'shell.rail.documents',
    icon: 'document',
    render: (tab) => <DocumentsScreen tab={tab} />,
  })
  registerObjectView({
    type: 'document',
    render: (tab) => (
      <DocumentView
        objectId={tab.objectId!}
        tabId={tab.id}
        savedState={tab.state as Parameters<typeof DocumentView>[0]['savedState']}
      />
    ),
    contextSection: (objectId) => <DocumentContextSection objectId={objectId} />,
    assistantSection: (objectId) => <DocumentAssistant documentId={objectId} />,
  })
  registerObjectView({
    type: 'journal',
    render: (tab) => <JournalsDirectory selectedId={tab.objectId!} />,
  })
  registerObjectView({
    type: 'correspondent',
    render: (tab) => <CorrespondentsDirectory selectedId={tab.objectId!} />,
  })
  registerObjectView({
    type: 'document_type',
    render: (tab) => <TypesDirectory selectedId={tab.objectId!} />,
  })
  registerObjectView({
    type: 'case',
    render: (tab) => <CasesDirectory selectedId={tab.objectId!} />,
  })
  registerObjectView({
    type: 'template',
    render: (tab) => <TemplatesDirectory selectedId={tab.objectId!} />,
  })
  registerObjectView({
    type: 'layer',
    render: (tab) => (
      <LayerView
        objectId={tab.objectId!}
        tabId={tab.id}
        savedState={tab.state as Parameters<typeof LayerView>[0]['savedState']}
      />
    ),
  })
}
