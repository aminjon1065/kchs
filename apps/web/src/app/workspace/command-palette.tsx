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
  CalendarDays,
  CircleHelp,
  ClipboardCheck,
  Home,
  Inbox,
  LayoutGrid,
  LayoutPanelLeft,
  Moon,
  Palette,
  Search,
  Settings,
  Shield,
  Sun,
  Trash2,
  Users,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import {
  meQuery,
  recentQuery,
  searchQuery,
  spacesQuery,
  workspacesQuery,
} from '~/shared/api/queries.js'
import { useAppearance } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useOpenWorkspace } from '~/shared/workspace/open-workspace.js'
import { type PaletteCommand, shellExtension } from '~/shared/workspace/registry.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import type { ScreenKey } from '~/shared/workspace/types.js'

// Запасные варианты, если модуля с возможностью нет в сборке
const noHelp = () => null
const noAdmin = () => false
const noQuickAction = () => null
const NO_COMMANDS: PaletteCommand[] = []
const noCommands = () => NO_COMMANDS

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
  // Справка, консоль, быстрые действия и команды — возможности модулей (ADR-0183)
  const useOpenHelp = shellExtension('useOpenHelp', noHelp)
  const openHelp = useOpenHelp()
  const canOpenAdmin = shellExtension('canOpenAdmin', noAdmin)
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

  const { data: workspaces = [] } = useQuery(workspacesQuery())
  const openWorkspace = useOpenWorkspace()
  // «Встреча завтра в 10 с Ивановым» — событие из палитры (ADR-0081)
  const useQuickAction = shellExtension('usePaletteQuickAction', noQuickAction)
  const quickEvent = useQuickAction(query)
  const useModuleCommands = shellExtension('usePaletteCommands', noCommands)
  const moduleCommands = useModuleCommands()

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
        id: 'calendar',
        label: t('shell.rail.calendar'),
        icon: <CalendarDays />,
        run: () => goScreen('calendar', t('shell.rail.calendar'), 'calendar'),
      },
      ...moduleCommands,
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
        id: 'control',
        label: t('shell.screens.control'),
        icon: <ClipboardCheck />,
        run: () => goScreen('control', t('shell.screens.control'), 'task'),
      },
      {
        id: 'workload',
        label: t('shell.screens.workload'),
        icon: <Users />,
        run: () => goScreen('workload', t('shell.screens.workload'), 'user'),
      },
      {
        id: 'forms',
        label: t('shell.rail.forms'),
        icon: <ObjectIcon type="form" />,
        run: () => goScreen('forms', t('shell.rail.forms'), 'form'),
      },
      {
        id: 'alerts',
        label: t('shell.rail.alerts'),
        icon: <ObjectIcon type="alert" />,
        run: () => goScreen('alerts', t('shell.rail.alerts'), 'alert'),
      },
      {
        id: 'pipelines',
        label: t('shell.screens.pipelines'),
        icon: <ObjectIcon type="pipeline" />,
        run: () => goScreen('pipelines', t('shell.screens.pipelines'), 'pipeline'),
      },
      {
        id: 'territories',
        label: t('shell.screens.territories'),
        icon: <ObjectIcon type="territory" />,
        run: () => goScreen('territories', t('shell.screens.territories'), 'territory'),
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
        label: t('shell.rail.admin'),
        icon: <Shield />,
        hidden: !canOpenAdmin(me?.capabilities),
        run: () => goScreen('admin', t('shell.rail.admin'), 'role'),
      },
      {
        id: 'help',
        label: t('shell.rail.help'),
        icon: <CircleHelp />,
        hidden: !openHelp,
        run: () => {
          openHelp?.()
          close()
        },
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
      // Именованные рабочие пространства открываются одним действием
      ...workspaces.map((item) => ({
        id: `workspace-${item.id}`,
        label: t('shell.workspaces.paletteOpen', { title: item.title }),
        icon: <LayoutPanelLeft />,
        run: () => {
          void openWorkspace(item)
          close()
        },
      })),
    ]
    const normalized = query.trim().toLowerCase()
    return items.filter(
      (item) => !item.hidden && (!normalized || item.label.toLowerCase().includes(normalized)),
    )
  }, [
    query,
    t,
    me,
    density,
    setTheme,
    setDensity,
    goScreen,
    close,
    workspaces,
    openWorkspace,
    moduleCommands,
    openHelp,
    canOpenAdmin,
  ])

  const spaceMatches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return spaces.filter((space) => space.name.toLowerCase().includes(normalized)).slice(0, 4)
  }, [query, spaces])

  // Порядок элементов определяет, что выделено по умолчанию
  const firstValue =
    (quickEvent ? 'quick-event' : '') ||
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
            <Kbd>↓</Kbd> {t('shell.palette.hintSelect')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> {t('shell.palette.hintOpen')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⌘↵</Kbd> {t('shell.palette.hintNewTab')}
          </span>
        </>
      }
    >
      {quickEvent ? (
        <CommandGroup>
          <CommandGroupHeading>{t(quickEvent.groupKey)}</CommandGroupHeading>
          <CommandItem
            value="quick-event"
            icon={quickEvent.icon}
            hint={quickEvent.hint}
            onSelect={() => {
              quickEvent.run()
              close()
            }}
          >
            {quickEvent.label}
          </CommandItem>
        </CommandGroup>
      ) : null}

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
