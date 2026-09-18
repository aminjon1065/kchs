import { AdminScreen } from '~/features/admin/admin-screen.js'
import { DataCatalogScreen } from '~/features/data/data-catalog-screen.js'
import { DatasetView } from '~/features/data/dataset-view.js'
import { FilesScreen } from '~/features/files/files-screen.js'
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
    type: 'dataset',
    render: (tab) => <DatasetView objectId={tab.objectId!} tabId={tab.id} />,
  })
  registerObjectView({ type: 'space', render: (tab) => <SpaceScreen spaceId={tab.objectId!} /> })
}
