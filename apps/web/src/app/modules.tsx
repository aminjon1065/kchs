import { AdminScreen } from '~/features/admin/admin-screen.js'
import { AnalysisView } from '~/features/data/analysis-view.js'
import { ChartView } from '~/features/data/chart-view.js'
import { DashboardView } from '~/features/data/dashboard-view.js'
import { DataCatalogScreen } from '~/features/data/data-catalog-screen.js'
import { DatasetView } from '~/features/data/dataset-view.js'
import { ExploreScreen } from '~/features/data/explore-screen.js'
import { MetricView } from '~/features/data/metric-view.js'
import { type SavedSqlLab, SqlLabScreen } from '~/features/data/sql-lab-screen.js'
import { FilesScreen } from '~/features/files/files-screen.js'
import { TerritoriesScreen } from '~/features/gis/territories-screen.js'
import { TerritoryView } from '~/features/gis/territory-view.js'
import { HomeScreen } from '~/features/home/home-screen.js'
import { InboxScreen } from '~/features/inbox/inbox-screen.js'
import { NotificationsScreen } from '~/features/notifications/notifications-screen.js'
import { FileView } from '~/features/objects/file-view.js'
import { FolderView } from '~/features/objects/folder-view.js'
import { TrashScreen } from '~/features/objects/trash-screen.js'
import { ProfileScreen } from '~/features/profile/profile-screen.js'
import { SearchScreen } from '~/features/search/search-screen.js'
import { SpaceScreen } from '~/features/spaces/space-screen.js'
import { SpacesScreen } from '~/features/spaces/spaces-screen.js'
import { ProjectView } from '~/features/tasks/project-view.js'
import { TaskView } from '~/features/tasks/task-view.js'
import { TasksScreen, type TasksScreenState } from '~/features/tasks/tasks-screen.js'
import { registerObjectView, registerScreen } from './workspace/registry.js'

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
    key: 'search',
    titleKey: 'shell.rail.search',
    icon: 'view',
    render: (tab) => <SearchScreen initialQuery={tab.params.q ?? ''} />,
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
    type: 'metric',
    render: (tab) => <MetricView objectId={tab.objectId!} tabId={tab.id} />,
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
}
