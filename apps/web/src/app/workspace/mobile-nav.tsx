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
import {
  Bell,
  CircleHelp,
  Folder,
  Home,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Search,
} from 'lucide-react'
import { canOpenAdmin } from '~/features/admin/sections.js'
import { chatListQuery } from '~/features/chat/queries.js'
import { useOpenHelp } from '~/features/knowledge/help.js'
import { inboxCountsQuery, meQuery } from '~/shared/api/queries.js'
import { useT } from '../i18n.js'
import { useWorkspace } from './store.js'
import type { ScreenKey } from './types.js'

/**
 * Нижняя навигация мобильного веба (03-ui/01-ux-concept.md, адаптив):
 * Мой день, Входящие, Поиск, Чаты, Ещё; файлы и остальное — в «Ещё».
 */
export function MobileNav({ onOpenPalette }: { onOpenPalette: () => void }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const navigatorModule = useWorkspace((s) => s.navigatorModule)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  const { data: counts } = useQuery(inboxCountsQuery())
  const { data: me } = useQuery(meQuery())
  const openHelp = useOpenHelp()
  const { data: chats } = useQuery(chatListQuery('all'))

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
    {
      key: 'chats' as const,
      icon: MessageSquare,
      labelKey: 'shell.rail.chats',
      iconName: 'conversation',
      badge: chats?.totalUnread,
    },
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
            icon={<Folder className="size-4" />}
            onSelect={() => go('files', 'shell.rail.files', 'folder')}
          >
            {t('shell.rail.files')}
          </DropdownMenuItem>
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
          {openHelp ? (
            <DropdownMenuItem icon={<CircleHelp className="size-4" />} onSelect={openHelp}>
              {t('shell.rail.help')}
            </DropdownMenuItem>
          ) : null}
          {canOpenAdmin(me?.capabilities) ? (
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
