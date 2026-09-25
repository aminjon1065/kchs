import { Skeleton } from '@kchs/ui'
import { lazy, Suspense } from 'react'
import type { CalendarScreenState } from '~/features/calendar/calendar-screen.js'
import type { ChatsScreenState } from '~/features/chat/chats-screen.js'
import type { SavedSqlLab } from '~/features/data/sql-lab-screen.js'
import type { MapTabState } from '~/features/gis/map-studio.js'
import { HomeScreen } from '~/features/home/home-screen.js'
import type { ControlScreenState } from '~/features/tasks/control-screen.js'
import type { TasksScreenState } from '~/features/tasks/tasks-screen.js'
import type { WorkloadScreenState } from '~/features/tasks/workload-screen.js'
import { registerObjectView, registerScreen } from './workspace/registry.js'

/**
 * Экраны и представления объектов грузятся при первом открытии (отдельными чанками): в
 * основном фрагменте — оболочка и «Мой день». Заглушка на время загрузки — у области вкладок
 * и контекст-панели (Suspense).
 */
const AdminScreen = lazy(() =>
  import('~/features/admin/admin-screen.js').then((module) => ({ default: module.AdminScreen })),
)
const AssistantScreen = lazy(() =>
  import('~/features/assistant/assistant-screen.js').then((module) => ({
    default: module.AssistantScreen,
  })),
)
const CalendarScreen = lazy(() =>
  import('~/features/calendar/calendar-screen.js').then((module) => ({
    default: module.CalendarScreen,
  })),
)
const CalendarView = lazy(() =>
  import('~/features/calendar/calendar-view.js').then((module) => ({
    default: module.CalendarView,
  })),
)
const EventView = lazy(() =>
  import('~/features/calendar/event-view.js').then((module) => ({ default: module.EventView })),
)
const ChatsScreen = lazy(() =>
  import('~/features/chat/chats-screen.js').then((module) => ({ default: module.ChatsScreen })),
)
const AnalysisView = lazy(() =>
  import('~/features/data/analysis-view.js').then((module) => ({ default: module.AnalysisView })),
)
const ChartView = lazy(() =>
  import('~/features/data/chart-view.js').then((module) => ({ default: module.ChartView })),
)
const DashboardView = lazy(() =>
  import('~/features/data/dashboard-view.js').then((module) => ({ default: module.DashboardView })),
)
const DataCatalogScreen = lazy(() =>
  import('~/features/data/data-catalog-screen.js').then((module) => ({
    default: module.DataCatalogScreen,
  })),
)
const DatasetView = lazy(() =>
  import('~/features/data/dataset-view.js').then((module) => ({ default: module.DatasetView })),
)
const ExploreScreen = lazy(() =>
  import('~/features/data/explore-screen.js').then((module) => ({ default: module.ExploreScreen })),
)
const MetricView = lazy(() =>
  import('~/features/data/metric-view.js').then((module) => ({ default: module.MetricView })),
)
const PipelinesScreen = lazy(() =>
  import('~/features/data/pipelines/pipelines-screen.js').then((module) => ({
    default: module.PipelinesScreen,
  })),
)
const SqlLabScreen = lazy(() =>
  import('~/features/data/sql-lab-screen.js').then((module) => ({ default: module.SqlLabScreen })),
)
const DocumentAssistant = lazy(() =>
  import('~/features/documents/assist/document-assistant.js').then((module) => ({
    default: module.DocumentAssistant,
  })),
)
const DocumentContextSection = lazy(() =>
  import('~/features/documents/card/document-view.js').then((module) => ({
    default: module.DocumentContextSection,
  })),
)
const DocumentView = lazy(() =>
  import('~/features/documents/card/document-view.js').then((module) => ({
    default: module.DocumentView,
  })),
)
const CasesDirectory = lazy(() =>
  import('~/features/documents/directories/cases-directory.js').then((module) => ({
    default: module.CasesDirectory,
  })),
)
const CorrespondentsDirectory = lazy(() =>
  import('~/features/documents/directories/correspondents-directory.js').then((module) => ({
    default: module.CorrespondentsDirectory,
  })),
)
const JournalsDirectory = lazy(() =>
  import('~/features/documents/directories/journals-directory.js').then((module) => ({
    default: module.JournalsDirectory,
  })),
)
const TemplatesDirectory = lazy(() =>
  import('~/features/documents/directories/templates-directory.js').then((module) => ({
    default: module.TemplatesDirectory,
  })),
)
const TypesDirectory = lazy(() =>
  import('~/features/documents/directories/types-directory.js').then((module) => ({
    default: module.TypesDirectory,
  })),
)
const DocumentsScreen = lazy(() =>
  import('~/features/documents/documents-screen.js').then((module) => ({
    default: module.DocumentsScreen,
  })),
)
const FilesScreen = lazy(() =>
  import('~/features/files/files-screen.js').then((module) => ({ default: module.FilesScreen })),
)
const OfficeEditorScreen = lazy(() =>
  import('~/features/files/office-editor.js').then((module) => ({
    default: module.OfficeEditorScreen,
  })),
)
const LayerView = lazy(() =>
  import('~/features/gis/layer-view.js').then((module) => ({ default: module.LayerView })),
)
const MapStudio = lazy(() =>
  import('~/features/gis/map-studio.js').then((module) => ({ default: module.MapStudio })),
)
const MapsScreen = lazy(() =>
  import('~/features/gis/maps-screen.js').then((module) => ({ default: module.MapsScreen })),
)
const TerritoriesScreen = lazy(() =>
  import('~/features/gis/territories-screen.js').then((module) => ({
    default: module.TerritoriesScreen,
  })),
)
const TerritoryView = lazy(() =>
  import('~/features/gis/territory-view.js').then((module) => ({ default: module.TerritoryView })),
)
const InboxScreen = lazy(() =>
  import('~/features/inbox/inbox-screen.js').then((module) => ({ default: module.InboxScreen })),
)
const KnowledgeScreen = lazy(() =>
  import('~/features/knowledge/knowledge-screen.js').then((module) => ({
    default: module.KnowledgeScreen,
  })),
)
const MeetingsScreen = lazy(() =>
  import('~/features/meetings/meetings-screen.js').then((module) => ({
    default: module.MeetingsScreen,
  })),
)
const NotificationsScreen = lazy(() =>
  import('~/features/notifications/notifications-screen.js').then((module) => ({
    default: module.NotificationsScreen,
  })),
)
const FileView = lazy(() =>
  import('~/features/objects/file-view.js').then((module) => ({ default: module.FileView })),
)
const FolderView = lazy(() =>
  import('~/features/objects/folder-view.js').then((module) => ({ default: module.FolderView })),
)
const TrashScreen = lazy(() =>
  import('~/features/objects/trash-screen.js').then((module) => ({ default: module.TrashScreen })),
)
const ProfileScreen = lazy(() =>
  import('~/features/profile/profile-screen.js').then((module) => ({
    default: module.ProfileScreen,
  })),
)
const SearchScreen = lazy(() =>
  import('~/features/search/search-screen.js').then((module) => ({ default: module.SearchScreen })),
)
const SpaceScreen = lazy(() =>
  import('~/features/spaces/space-screen.js').then((module) => ({ default: module.SpaceScreen })),
)
const SpacesScreen = lazy(() =>
  import('~/features/spaces/spaces-screen.js').then((module) => ({ default: module.SpacesScreen })),
)
const ControlScreen = lazy(() =>
  import('~/features/tasks/control-screen.js').then((module) => ({
    default: module.ControlScreen,
  })),
)
const ProjectView = lazy(() =>
  import('~/features/tasks/project-view.js').then((module) => ({ default: module.ProjectView })),
)
const TaskView = lazy(() =>
  import('~/features/tasks/task-view.js').then((module) => ({ default: module.TaskView })),
)
const TasksScreen = lazy(() =>
  import('~/features/tasks/tasks-screen.js').then((module) => ({ default: module.TasksScreen })),
)
const WorkloadScreen = lazy(() =>
  import('~/features/tasks/workload-screen.js').then((module) => ({
    default: module.WorkloadScreen,
  })),
)

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
/** Конструктор пайплайна (ADR-0106): тяжёлый экран — грузится по требованию. */
const PipelineDesigner = lazy(() => import('~/features/data/pipelines/pipeline-designer.js'))
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
    key: 'office-editor',
    titleKey: 'files.office.title',
    icon: 'file',
    render: (tab) => <OfficeEditorScreen fileId={tab.params.id ?? ''} tabId={tab.id} />,
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
    key: 'pipelines',
    titleKey: 'data.pipelines.title',
    icon: 'pipeline',
    render: () => <PipelinesScreen />,
  })
  registerObjectView({
    type: 'pipeline',
    render: (tab) => (
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <PipelineDesigner pipelineId={tab.objectId ?? ''} />
      </Suspense>
    ),
  })
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
