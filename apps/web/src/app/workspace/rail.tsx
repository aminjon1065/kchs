import { Avatar, cn, Tooltip } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Bot,
  CircleHelp,
  Inbox,
  type LucideIcon,
  Search,
  Settings,
  Shield,
} from 'lucide-react'
import { useBranding } from '~/shared/api/branding.js'
import { inboxCountsQuery, meQuery, notificationsQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import {
  listNavItems,
  type NavItemDefinition,
  shellExtension,
} from '~/shared/workspace/registry.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import type { ScreenKey } from '~/shared/workspace/types.js'

interface RailItem {
  key: ScreenKey
  icon: LucideIcon
  labelKey: string
  shortcut?: string
  /** Модуль появится в следующих фазах — показываем как «скоро». */
  soon?: boolean
}

const noHelp = () => null
const noAdmin = () => false
const noBadge = () => undefined

export function Rail({ onOpenPalette }: { onOpenPalette: () => void }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const navigatorModule = useWorkspace((s) => s.navigatorModule)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)

  const { data: me } = useQuery(meQuery())
  // Экраны выключенных возможностей (15-admin-operations.md §1) рейка не показывает
  const hidden = new Set<string>(me?.hiddenScreens ?? [])
  const branding = useBranding()
  const brandName = branding?.shortName || branding?.name || t('common.appName')
  const { data: counts } = useQuery(inboxCountsQuery())
  const { data: notifications } = useQuery(notificationsQuery(true))
  // Пункты модулей — из реестра оболочки (ADR-0183): рейка модулей не знает
  const primary = listNavItems()

  // Консоль — по любой способности её разделов (N85), не только администратору системы
  const isAdmin = shellExtension('canOpenAdmin', noAdmin)(me?.capabilities)
  const useOpenHelp = shellExtension('useOpenHelp', noHelp)
  const openHelp = useOpenHelp()

  const open = (item: Pick<RailItem, 'key' | 'labelKey'> & Partial<RailItem>): void => {
    setNavigatorModule(item.key)
    openTab({
      kind: 'screen',
      screen: item.key,
      title: t(item.labelKey),
      icon: item.key,
      mode: 'permanent',
    })
  }

  return (
    <nav
      aria-label={t('shell.navigator.title')}
      className="flex h-full w-(--rail-w) shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-2 py-2"
    >
      <button
        type="button"
        onClick={() => open({ key: 'home', labelKey: 'shell.rail.home' })}
        className={cn(
          'mb-1 flex size-8 items-center justify-center overflow-hidden rounded-md',
          branding?.logo ? 'bg-surface' : 'bg-accent text-accent-fg',
        )}
        aria-label={brandName}
      >
        {branding?.logo ? (
          <img src={branding.logo} alt="" className="size-full object-contain" />
        ) : (
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
            <path
              d="M9 8v16M9 16l8-8M9 16l8 8"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        )}
      </button>

      <div className="flex flex-col items-center gap-0.5">
        {primary
          .filter((item) => !hidden.has(item.key))
          .map((item) => (
            <ModuleRailButton
              key={item.key}
              item={item}
              active={navigatorModule === item.key}
              label={t(item.labelKey)}
              onClick={() => open(item)}
            />
          ))}
      </div>

      <div className="mt-auto flex flex-col items-center gap-0.5">
        <RailButton
          item={{ key: 'search', icon: Search, labelKey: 'shell.rail.search', shortcut: 'mod+k' }}
          label={t('shell.rail.search')}
          active={false}
          onClick={onOpenPalette}
        />
        <RailButton
          item={{ key: 'inbox', icon: Inbox, labelKey: 'shell.rail.inbox', shortcut: 'G I' }}
          label={t('shell.rail.inbox')}
          active={navigatorModule === 'inbox'}
          badge={counts?.total}
          badgeTone={counts && counts.overdue > 0 ? 'danger' : 'accent'}
          onClick={() => open({ key: 'inbox', icon: Inbox, labelKey: 'shell.rail.inbox' })}
        />
        <RailButton
          item={{ key: 'notifications', icon: Bell, labelKey: 'shell.rail.notifications' }}
          label={t('shell.rail.notifications')}
          active={navigatorModule === 'notifications'}
          badge={notifications?.unread}
          onClick={() =>
            open({ key: 'notifications', icon: Bell, labelKey: 'shell.rail.notifications' })
          }
        />
        {hidden.has('assistant') ? null : (
          <RailButton
            item={{ key: 'assistant', icon: Bot, labelKey: 'shell.rail.assistant' }}
            label={t('shell.rail.assistant')}
            active={navigatorModule === 'assistant'}
            onClick={() => open({ key: 'assistant', icon: Bot, labelKey: 'shell.rail.assistant' })}
          />
        )}
        {isAdmin ? (
          <RailButton
            item={{ key: 'admin', icon: Shield, labelKey: 'shell.rail.admin' }}
            label={t('shell.rail.admin')}
            active={navigatorModule === 'admin'}
            onClick={() => open({ key: 'admin', icon: Shield, labelKey: 'shell.rail.admin' })}
          />
        ) : null}
        {openHelp ? (
          <RailButton
            item={{ icon: CircleHelp }}
            label={t('shell.rail.help')}
            active={false}
            onClick={openHelp}
          />
        ) : null}
        <RailButton
          item={{ key: 'profile', icon: Settings, labelKey: 'common.actions.settings' }}
          label={t('common.actions.settings')}
          active={navigatorModule === 'profile'}
          onClick={() =>
            open({ key: 'profile', icon: Settings, labelKey: 'common.actions.settings' })
          }
        />
        {me ? (
          <button
            type="button"
            onClick={() => open({ key: 'profile', icon: Settings, labelKey: 'shell.rail.profile' })}
            className="mt-1 rounded-full"
            aria-label={me.user.displayName}
          >
            <Avatar name={me.user.displayName} src={me.user.avatarUrl} size="md" />
          </button>
        ) : null}
      </div>
    </nav>
  )
}

/** Пункт модуля: число на значке — хук модуля из реестра (непрочитанное в «Чатах»). */
function ModuleRailButton({
  item,
  label,
  active,
  onClick,
}: {
  item: NavItemDefinition
  label: string
  active: boolean
  onClick: () => void
}) {
  const useBadge = item.useBadge ?? noBadge
  const badge = useBadge()
  return (
    <RailButton
      item={item}
      active={active}
      label={label}
      {...(badge ? { badge } : {})}
      onClick={onClick}
    />
  )
}

function RailButton({
  item,
  label,
  active,
  badge,
  badgeTone = 'accent',
  disabled,
  onClick,
}: {
  /** Пункт рейки; у кнопок не-экранов («Справка») — только значок. */
  item: Pick<RailItem, 'icon' | 'shortcut' | 'soon'> & Partial<Pick<RailItem, 'key' | 'labelKey'>>
  label: string
  active: boolean
  badge?: number
  badgeTone?: 'accent' | 'danger'
  disabled?: boolean
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <Tooltip content={label} side="right" shortcut={item.shortcut} delay={250}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || item.soon}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex size-9 items-center justify-center rounded-md',
          'transition-colors duration-[var(--duration-fast)]',
          active
            ? 'bg-surface text-accent shadow-sm'
            : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
          (disabled || item.soon) && 'cursor-not-allowed opacity-40 hover:bg-transparent',
        )}
      >
        <Icon className="size-5" aria-hidden />
        {badge && badge > 0 ? (
          <span
            className={cn(
              'tabular absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center',
              'rounded-full px-1 text-2xs font-semibold',
              badgeTone === 'danger' ? 'bg-danger text-danger-fg' : 'bg-accent text-accent-fg',
            )}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
        {active ? (
          <span aria-hidden className="absolute -left-2 h-5 w-0.5 rounded-r-full bg-accent" />
        ) : null}
      </button>
    </Tooltip>
  )
}
