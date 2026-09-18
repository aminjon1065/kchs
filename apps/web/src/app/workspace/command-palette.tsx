import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupHeading,
  CommandItem,
  Kbd,
  ObjectIcon,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Home,
  Inbox,
  LayoutGrid,
  Moon,
  Palette,
  Search,
  Settings,
  Shield,
  Sun,
  Trash2,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { meQuery, recentQuery, searchQuery, spacesQuery } from '~/shared/api/queries.js'
import { useAppearance } from '../appearance.js'
import { useT } from '../i18n.js'
import { useWorkspace } from './store.js'
import type { ScreenKey } from './types.js'

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const [value, setValue] = useState('')
  const query = useDebouncedValue(value, 150)

  const openTab = useWorkspace((s) => s.openTab)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  const setTheme = useAppearance((s) => s.setTheme)
  const setDensity = useAppearance((s) => s.setDensity)
  const density = useAppearance((s) => s.density)

  const { data: me } = useQuery(meQuery())
  const { data: recent = [] } = useQuery(recentQuery())
  const { data: spaces = [] } = useQuery(spacesQuery())
  const { data: results, isFetching } = useQuery(searchQuery({ q: query, limit: 8 }))

  const close = useCallback((): void => {
    onOpenChange(false)
    setValue('')
  }, [onOpenChange])

  const goScreen = useCallback(
    (screen: ScreenKey, title: string, icon: string): void => {
      setNavigatorModule(screen)
      openTab({ kind: 'screen', screen, title, icon, mode: 'permanent' })
      close()
    },
    [close, openTab, setNavigatorModule],
  )

  const commands = useMemo(() => {
    const items: Array<{
      id: string
      label: string
      icon: React.ReactNode
      shortcut?: string
      run: () => void
      hidden?: boolean
    }> = [
      {
        id: 'home',
        label: t('shell.rail.home'),
        icon: <Home />,
        shortcut: 'G H',
        run: () => goScreen('home', t('shell.rail.home'), 'home'),
      },
      {
        id: 'inbox',
        label: t('shell.rail.inbox'),
        icon: <Inbox />,
        shortcut: 'G I',
        run: () => goScreen('inbox', t('shell.rail.inbox'), 'inbox'),
      },
      {
        id: 'files',
        label: t('shell.rail.files'),
        icon: <ObjectIcon type="folder" />,
        shortcut: 'G F',
        run: () => goScreen('files', t('shell.rail.files'), 'folder'),
      },
      {
        id: 'notifications',
        label: t('shell.rail.notifications'),
        icon: <Bell />,
        run: () => goScreen('notifications', t('shell.rail.notifications'), 'notification'),
      },
      {
        id: 'search',
        label: t('search.title'),
        icon: <Search />,
        run: () => goScreen('search', t('search.title'), 'view'),
      },
      {
        id: 'spaces',
        label: t('spaces.title'),
        icon: <LayoutGrid />,
        run: () => goScreen('spaces', t('spaces.title'), 'space'),
      },
      {
        id: 'trash',
        label: t('objects.trash.title'),
        icon: <Trash2 />,
        run: () => goScreen('trash', t('objects.trash.title'), 'folder'),
      },
      {
        id: 'profile',
        label: t('common.actions.settings'),
        icon: <Settings />,
        run: () => goScreen('profile', t('common.actions.settings'), 'user'),
      },
      {
        id: 'admin',
        label: t('admin.title'),
        icon: <Shield />,
        hidden: !me?.capabilities.includes('admin.system'),
        run: () => goScreen('admin', t('admin.title'), 'role'),
      },
      {
        id: 'theme-light',
        label: `${t('common.labels.theme')}: ${t('common.theme.light')}`,
        icon: <Sun />,
        run: () => {
          setTheme('light')
          close()
        },
      },
      {
        id: 'theme-dark',
        label: `${t('common.labels.theme')}: ${t('common.theme.dark')}`,
        icon: <Moon />,
        run: () => {
          setTheme('dark')
          close()
        },
      },
      {
        id: 'density',
        label: `${t('common.labels.density')}: ${density === 'compact' ? t('common.density.comfortable') : t('common.density.compact')}`,
        icon: <Palette />,
        run: () => {
          setDensity(density === 'compact' ? 'comfortable' : 'compact')
          close()
        },
      },
    ]
    const normalized = query.trim().toLowerCase()
    return items.filter(
      (item) => !item.hidden && (!normalized || item.label.toLowerCase().includes(normalized)),
    )
  }, [query, t, me, density, setTheme, setDensity, goScreen, close])

  const spaceMatches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return spaces.filter((space) => space.name.toLowerCase().includes(normalized)).slice(0, 4)
  }, [query, spaces])

  // Порядок элементов определяет, что выделено по умолчанию
  const firstValue =
    (!query && recent[0] ? `recent-${recent[0].id}` : '') ||
    (results?.hits[0] ? `hit-${results.hits[0].objectId}` : '') ||
    (spaceMatches[0] ? `space-${spaceMatches[0].id}` : '') ||
    (commands[0] ? `cmd-${commands[0].id}` : '')

  return (
    <CommandDialog
      open={open}
      firstValue={firstValue}
      onOpenChange={(next) => {
        if (!next) close()
        else onOpenChange(true)
      }}
      value={value}
      onValueChange={setValue}
      loading={isFetching}
      placeholder={t('shell.palette.placeholder')}
      footer={
        <>
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> выбрать
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> открыть
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⌘↵</Kbd> в новой вкладке
          </span>
        </>
      }
    >
      {!query && recent.length > 0 ? (
        <CommandGroup>
          <CommandGroupHeading>{t('shell.palette.recent')}</CommandGroupHeading>
          {recent.slice(0, 5).map((item) => (
            <CommandItem
              key={item.id}
              value={`recent-${item.id}`}
              icon={<ObjectIcon type={item.type} />}
              hint={t(`objects.types.${item.type}`)}
              onSelect={() => {
                openTab({
                  kind: 'object',
                  objectId: item.id,
                  objectType: item.type,
                  title: item.title,
                  mode: 'permanent',
                })
                close()
              }}
            >
              {item.title}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}

      {results?.hits.length ? (
        <CommandGroup>
          <CommandGroupHeading>{t('shell.palette.objects')}</CommandGroupHeading>
          {results.hits.map((hit) => (
            <CommandItem
              key={hit.objectId}
              value={`hit-${hit.objectId}`}
              icon={<ObjectIcon type={hit.type} />}
              hint={hit.spaceName ?? t(`objects.types.${hit.type}`)}
              onSelect={() => {
                openTab({
                  kind: 'object',
                  objectId: hit.objectId,
                  objectType: hit.type,
                  title: stripMarks(hit.title),
                  mode: 'permanent',
                })
                close()
              }}
            >
              {stripMarks(hit.title)}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}

      {spaceMatches.length > 0 ? (
        <CommandGroup>
          <CommandGroupHeading>{t('spaces.title')}</CommandGroupHeading>
          {spaceMatches.map((space) => (
            <CommandItem
              key={space.id}
              value={`space-${space.id}`}
              icon={<ObjectIcon type="space" />}
              hint={t(`spaces.kinds.${space.kind}`)}
              onSelect={() => {
                openTab({
                  kind: 'screen',
                  screen: 'space',
                  title: space.name,
                  icon: 'space',
                  params: { spaceId: space.id },
                  mode: 'permanent',
                })
                close()
              }}
            >
              {space.name}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}

      <CommandGroup>
        <CommandGroupHeading>{t('shell.palette.commands')}</CommandGroupHeading>
        {commands.map((command) => (
          <CommandItem
            key={command.id}
            value={`cmd-${command.id}`}
            icon={command.icon}
            shortcut={command.shortcut}
            onSelect={command.run}
          >
            {command.label}
          </CommandItem>
        ))}
      </CommandGroup>

      <CommandEmpty>
        <div className="px-3 py-6 text-center text-sm text-fg-muted">
          {t('shell.palette.noResults')}
        </div>
      </CommandEmpty>
    </CommandDialog>
  )
}

function stripMarks(value: string): string {
  return value.replace(/<\/?mark>/g, '')
}
