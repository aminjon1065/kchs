import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  IconButton,
} from '@kchs/ui'
import { Link2, Link2Off } from 'lucide-react'
import { useT } from '../i18n.js'
import { useWorkspace } from './store.js'
import type { PaneState } from './types.js'
import { LINK_GROUPS } from './view-context.js'

/** Цвет метки группы связи — те же цвета, что у групп вкладок. */
const LINK_COLORS: Record<string, string> = {
  blue: 'bg-chart-1',
  orange: 'bg-chart-2',
  green: 'bg-chart-3',
  red: 'bg-chart-4',
  purple: 'bg-chart-5',
}

const NONE = 'none'

/**
 * Связь панели (ViewContext, ADR-0073): панели одной группы делят выделение,
 * фильтры и охват карты по датасету. Цветная метка — группа; «Без связи» —
 * панель живёт сама по себе.
 */
export function PaneLinkMenu({ pane }: { pane: PaneState }) {
  const t = useT()
  const setPaneLinkGroup = useWorkspace((s) => s.setPaneLinkGroup)
  const group = pane.linkGroup ?? null
  const label = group
    ? t('shell.link.linked', { color: t(`shell.tabs.colors.${group}`) })
    : t('shell.link.unlinked')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="sm" className="relative">
          {group ? (
            <>
              <Link2 className="size-3.5" aria-hidden />
              <span
                aria-hidden
                className={cn(
                  'absolute bottom-0.5 right-0.5 size-1.5 rounded-full',
                  LINK_COLORS[group] ?? 'bg-accent',
                )}
              />
            </>
          ) : (
            <Link2Off className="size-3.5" aria-hidden />
          )}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('shell.link.title')}</DropdownMenuLabel>
        <p className="max-w-64 px-2 pb-1.5 text-xs text-fg-muted">{t('shell.link.hint')}</p>
        <DropdownMenuRadioGroup
          value={group ?? NONE}
          onValueChange={(value) => setPaneLinkGroup(pane.id, value === NONE ? null : value)}
        >
          {LINK_GROUPS.map((item) => (
            <DropdownMenuRadioItem key={item} value={item}>
              <span className="flex items-center gap-2">
                <span aria-hidden className={cn('size-2.5 rounded-full', LINK_COLORS[item])} />
                {t('shell.link.group', { color: t(`shell.tabs.colors.${item}`) })}
              </span>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value={NONE}>{t('shell.link.none')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
