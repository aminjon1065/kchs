import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ObjectIcon,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Bell, Folder, Home, Inbox, MoreHorizontal, Search } from 'lucide-react'
import { inboxCountsQuery, meQuery } from '~/shared/api/queries.js'
import { useT } from '../i18n.js'
import { useWorkspace } from './store.js'
import type { ScreenKey } from './types.js'

/**
 * Нижняя навигация мобильного веба (03-ui/01-ux-concept.md §9):
 * Мой день, Входящие, Поиск, Файлы, Ещё.
 */
export function MobileNav({ onOpenPalette }: { onOpenPalette: () => void }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const navigatorModule = useWorkspace((s) => s.navigatorModule)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  const { data: counts } = useQuery(inboxCountsQuery())
  const { data: me } = useQuery(meQuery())

  const go = (screen: ScreenKey, labelKey: string, icon: string): void => {
    setNavigatorModule(screen)
    openTab({ kind: 'screen', screen, title: t(labelKey), icon, mode: 'permanent' })
  }

  const items = [
    { key: 'home' as const, icon: Home, labelKey: 'shell.rail.home', iconName: 'home' },
    {
      key: 'inbox' as const,
      icon: Inbox,
      labelKey: 'shell.rail.inbox',
      iconName: 'inbox',
      badge: counts?.total,
    },
    {
      key: 'search' as const,
      icon: Search,
      labelKey: 'shell.rail.search',
      iconName: 'view',
      action: onOpenPalette,
    },
    { key: 'files' as const, icon: Folder, labelKey: 'shell.rail.files', iconName: 'folder' },
  ]

  return (
    <nav
      aria-label={t('shell.mobile.navLabel')}
      className="flex h-14 shrink-0 items-stretch border-t border-line bg-surface pb-[env(safe-area-inset-bottom,0px)]"
    >
      {items.map((item) => {
        const Icon = item.icon
        const active = navigatorModule === item.key
        return (
          <button
            key={item.key}
            type="button"
            onClick={() =>
              item.action ? item.action() : go(item.key, item.labelKey, item.iconName)
            }
            className={cn(
              'relative flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs',
              active ? 'text-accent' : 'text-fg-muted',
            )}
          >
            <Icon className="size-5" aria-hidden />
            {t(item.labelKey)}
            {item.badge && item.badge > 0 ? (
              <span className="tabular absolute right-[22%] top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-accent-fg">
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            ) : null}
          </button>
        )
      })}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs text-fg-muted"
          >
            <MoreHorizontal className="size-5" aria-hidden />
            {t('common.actions.more')}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="mb-2 min-w-[200px]">
          <DropdownMenuItem
            icon={<ObjectIcon type="space" className="size-4" />}
            onSelect={() => go('spaces', 'spaces.title', 'space')}
          >
            {t('spaces.title')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Bell className="size-4" />}
            onSelect={() => go('notifications', 'shell.rail.notifications', 'notification')}
          >
            {t('shell.rail.notifications')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<ObjectIcon type="user" className="size-4" />}
            onSelect={() => go('profile', 'shell.rail.profile', 'user')}
          >
            {me?.user.displayName ?? t('shell.rail.profile')}
          </DropdownMenuItem>
          {me?.capabilities.includes('admin.system') ? (
            <DropdownMenuItem
              icon={<ObjectIcon type="role" className="size-4" />}
              onSelect={() => go('admin', 'admin.title', 'role')}
            >
              {t('admin.title')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  )
}
