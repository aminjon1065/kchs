import { Skeleton } from '@kchs/ui'
import { lazy } from 'react'

/**
 * Экраны и представления объектов грузятся при первом открытии (отдельными чанками): в
 * основном фрагменте — оболочка и «Мой день». Заглушка на время загрузки — у области вкладок
 * и контекст-панели (Suspense).
 */
export const AdminScreen = lazy(() =>
  import('~/features/admin/admin-screen.js').then((module) => ({ default: module.AdminScreen })),
)
export const AssistantScreen = lazy(() =>
  import('~/features/assistant/assistant-screen.js').then((module) => ({
    default: module.AssistantScreen,
  })),
)
export const CalendarScreen = lazy(() =>
  import('~/features/calendar/calendar-screen.js').then((module) => ({
    default: module.CalendarScreen,
  })),
)
export const CalendarView = lazy(() =>
  import('~/features/calendar/calendar-view.js').then((module) => ({
    default: module.CalendarView,
  })),
)
export const EventView = lazy(() =>
  import('~/features/calendar/event-view.js').then((module) => ({ default: module.EventView })),
)
export const ChatsScreen = lazy(() =>
  import('~/features/chat/chats-screen.js').then((module) => ({ default: module.ChatsScreen })),
)
export const AnalysisView = lazy(() =>
  import('~/features/data/analysis-view.js').then((module) => ({ default: module.AnalysisView })),
)
export const ChartView = lazy(() =>
  import('~/features/data/chart-view.js').then((module) => ({ default: module.ChartView })),
)
export const DashboardView = lazy(() =>
  import('~/features/data/dashboard-view.js').then((module) => ({ default: module.DashboardView })),
)
export const DataCatalogScreen = lazy(() =>
  import('~/features/data/data-catalog-screen.js').then((module) => ({
    default: module.DataCatalogScreen,
  })),
)
export const DatasetView = lazy(() =>
  import('~/features/data/dataset-view.js').then((module) => ({ default: module.DatasetView })),
)
export const ExploreScreen = lazy(() =>
  import('~/features/data/explore-screen.js').then((module) => ({ default: module.ExploreScreen })),
)
export const MetricView = lazy(() =>
  import('~/features/data/metric-view.js').then((module) => ({ default: module.MetricView })),
)
export const PipelinesScreen = lazy(() =>
  import('~/features/data/pipelines/pipelines-screen.js').then((module) => ({
    default: module.PipelinesScreen,
  })),
)
export const SqlLabScreen = lazy(() =>
  import('~/features/data/sql-lab-screen.js').then((module) => ({ default: module.SqlLabScreen })),
)
export const DocumentAssistant = lazy(() =>
  import('~/features/documents/assist/document-assistant.js').then((module) => ({
    default: module.DocumentAssistant,
  })),
)
export const DocumentContextSection = lazy(() =>
  import('~/features/documents/card/document-view.js').then((module) => ({
    default: module.DocumentContextSection,
  })),
)
export const DocumentView = lazy(() =>
  import('~/features/documents/card/document-view.js').then((module) => ({
    default: module.DocumentView,
  })),
)
export const CasesDirectory = lazy(() =>
  import('~/features/documents/directories/cases-directory.js').then((module) => ({
    default: module.CasesDirectory,
  })),
)
export const CorrespondentsDirectory = lazy(() =>
  import('~/features/documents/directories/correspondents-directory.js').then((module) => ({
    default: module.CorrespondentsDirectory,
  })),
)
export const JournalsDirectory = lazy(() =>
  import('~/features/documents/directories/journals-directory.js').then((module) => ({
    default: module.JournalsDirectory,
  })),
)
export const TemplatesDirectory = lazy(() =>
  import('~/features/documents/directories/templates-directory.js').then((module) => ({
    default: module.TemplatesDirectory,
  })),
)
export const TypesDirectory = lazy(() =>
  import('~/features/documents/directories/types-directory.js').then((module) => ({
    default: module.TypesDirectory,
  })),
)
export const DocumentsScreen = lazy(() =>
  import('~/features/documents/documents-screen.js').then((module) => ({
    default: module.DocumentsScreen,
  })),
)
export const FilesScreen = lazy(() =>
  import('~/features/files/files-screen.js').then((module) => ({ default: module.FilesScreen })),
)
export const OfficeEditorScreen = lazy(() =>
  import('~/features/files/office-editor.js').then((module) => ({
    default: module.OfficeEditorScreen,
  })),
)
export const LayerView = lazy(() =>
  import('~/features/gis/layer-view.js').then((module) => ({ default: module.LayerView })),
)
export const MapStudio = lazy(() =>
  import('~/features/gis/map-studio.js').then((module) => ({ default: module.MapStudio })),
)
export const MapsScreen = lazy(() =>
  import('~/features/gis/maps-screen.js').then((module) => ({ default: module.MapsScreen })),
)
export const TerritoriesScreen = lazy(() =>
  import('~/features/gis/territories-screen.js').then((module) => ({
    default: module.TerritoriesScreen,
  })),
)
export const TerritoryView = lazy(() =>
  import('~/features/gis/territory-view.js').then((module) => ({ default: module.TerritoryView })),
)
export const InboxScreen = lazy(() =>
  import('~/features/inbox/inbox-screen.js').then((module) => ({ default: module.InboxScreen })),
)
export const KnowledgeScreen = lazy(() =>
  import('~/features/knowledge/knowledge-screen.js').then((module) => ({
    default: module.KnowledgeScreen,
  })),
)
export const MeetingsScreen = lazy(() =>
  import('~/features/meetings/meetings-screen.js').then((module) => ({
    default: module.MeetingsScreen,
  })),
)
export const NotificationsScreen = lazy(() =>
  import('~/features/notifications/notifications-screen.js').then((module) => ({
    default: module.NotificationsScreen,
  })),
)
export const FileView = lazy(() =>
  import('~/features/objects/file-view.js').then((module) => ({ default: module.FileView })),
)
export const FolderView = lazy(() =>
  import('~/features/objects/folder-view.js').then((module) => ({ default: module.FolderView })),
)
export const TrashScreen = lazy(() =>
  import('~/features/objects/trash-screen.js').then((module) => ({ default: module.TrashScreen })),
)
export const ProfileScreen = lazy(() =>
  import('~/features/profile/profile-screen.js').then((module) => ({
    default: module.ProfileScreen,
  })),
)
export const SearchScreen = lazy(() =>
  import('~/features/search/search-screen.js').then((module) => ({ default: module.SearchScreen })),
)
export const SpaceScreen = lazy(() =>
  import('~/features/spaces/space-screen.js').then((module) => ({ default: module.SpaceScreen })),
)
export const SpacesScreen = lazy(() =>
  import('~/features/spaces/spaces-screen.js').then((module) => ({ default: module.SpacesScreen })),
)
export const ControlScreen = lazy(() =>
  import('~/features/tasks/control-screen.js').then((module) => ({
    default: module.ControlScreen,
  })),
)
export const ProjectView = lazy(() =>
  import('~/features/tasks/project-view.js').then((module) => ({ default: module.ProjectView })),
)
export const TaskView = lazy(() =>
  import('~/features/tasks/task-view.js').then((module) => ({ default: module.TaskView })),
)
export const TasksScreen = lazy(() =>
  import('~/features/tasks/tasks-screen.js').then((module) => ({ default: module.TasksScreen })),
)
export const WorkloadScreen = lazy(() =>
  import('~/features/tasks/workload-screen.js').then((module) => ({
    default: module.WorkloadScreen,
  })),
)

/** Формы сбора данных и алерты (ADR-0103, ADR-0104) — отдельным чанком. */
export const FormsScreen = lazy(() =>
  import('~/features/forms/forms-screen.js').then((module) => ({ default: module.FormsScreen })),
)
export const FormView = lazy(() =>
  import('~/features/forms/form-view.js').then((module) => ({ default: module.FormView })),
)
export const AlertsScreen = lazy(() =>
  import('~/features/alerts/alerts-screen.js').then((module) => ({ default: module.AlertsScreen })),
)
export const AlertView = lazy(() =>
  import('~/features/alerts/alert-view.js').then((module) => ({ default: module.AlertView })),
)
/** Устройства слежения (ADR-0203) — отдельным чанком. */
export const DevicesScreen = lazy(() =>
  import('~/features/positions/devices-screen.js').then((module) => ({
    default: module.DevicesScreen,
  })),
)
export const DeviceView = lazy(() =>
  import('~/features/positions/device-view.js').then((module) => ({
    default: module.DeviceView,
  })),
)

/** Предупреждения CAP (ADR-0202) — отдельным чанком. */
export const WarningsScreen = lazy(() =>
  import('~/features/warnings/warnings-screen.js').then((module) => ({
    default: module.WarningsScreen,
  })),
)
export const WarningView = lazy(() =>
  import('~/features/warnings/warning-view.js').then((module) => ({
    default: module.WarningView,
  })),
)

/** Заглушка ленивого экрана: та же, что у конструкторов. */
export function LazyFallback() {
  return (
    <div className="flex flex-col gap-3 p-6">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

/** Тетрадь — отдельным чанком: Tiptap, Yjs и клиент совместной правки не в оболочке. */
export const NotebookView = lazy(() => import('~/features/notebooks/notebook-view.js'))
/** Отчёт — тоже отдельным чанком: тот же совместный документ, что у тетради (ADR-0078). */
export const ReportView = lazy(() => import('~/features/reports/report-view.js'))
/** Встреча и её протокол — отдельным чанком: Tiptap и клиент совместной правки (ADR-0093). */
export const MeetingView = lazy(() => import('~/features/meetings/meeting-view.js'))
export const ProtocolView = lazy(() => import('~/features/meetings/protocol/protocol-view.js'))
/** Страница базы знаний — отдельным чанком: Tiptap и клиент совместной правки (ADR-0095). */
export const PageView = lazy(() => import('~/features/knowledge/page-view.js'))
/** Конструктор маршрутов — отдельным чанком: нужен только администратору маршрутов (ADR-0087). */
export const ProcessDesigner = lazy(
  () => import('~/features/processes/designer/designer-screen.js'),
)
export const RuleDesigner = lazy(() => import('~/features/automation/designer/rule-designer.js'))
/** Конструктор пайплайна (ADR-0106): тяжёлый экран — грузится по требованию. */
export const PipelineDesigner = lazy(() => import('~/features/data/pipelines/pipeline-designer.js'))
/** Запись встречи — отдельным чанком: плеер и расшифровка нужны не всем (ADR-0092). */
export const RecordingView = lazy(() => import('~/features/meetings/recording/recording-view.js'))
