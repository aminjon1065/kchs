import { Dialog, DialogContent, formatShortcut, Kbd } from '@kchs/ui'
import { useT } from '../i18n.js'

interface ShortcutRow {
  combo: string
  /** Ключ словаря `shell.shortcuts.*`. */
  labelKey: string
}

const GROUPS: Array<{ titleKey: string; rows: ShortcutRow[] }> = [
  {
    titleKey: 'shell.shortcuts.groups.navigation',
    rows: [
      { combo: 'mod+k', labelKey: 'shell.shortcuts.commandPalette' },
      { combo: 'mod+b', labelKey: 'shell.shortcuts.navigator' },
      { combo: 'mod+.', labelKey: 'shell.shortcuts.contextPanel' },
      { combo: 'g h', labelKey: 'shell.shortcuts.goHome' },
      { combo: 'g i', labelKey: 'shell.shortcuts.goInbox' },
      { combo: 'g f', labelKey: 'shell.shortcuts.goFiles' },
      { combo: 'g d', labelKey: 'shell.rail.data' },
      { combo: 'g m', labelKey: 'shell.rail.maps' },
      { combo: 'g o', labelKey: 'shell.rail.documents' },
      { combo: 'g t', labelKey: 'shell.rail.tasks' },
      { combo: 'g c', labelKey: 'shell.rail.chats' },
    ],
  },
  {
    titleKey: 'shell.shortcuts.groups.tabs',
    rows: [
      { combo: 'mod+t', labelKey: 'shell.shortcuts.newTab' },
      { combo: 'mod+w', labelKey: 'shell.shortcuts.closeTab' },
      { combo: 'mod+shift+t', labelKey: 'shell.shortcuts.reopenTab' },
      { combo: 'mod+\\', labelKey: 'shell.shortcuts.splitPane' },
      { combo: 'mod+1', labelKey: 'shell.shortcuts.goToTab' },
      { combo: 'ctrl+tab', labelKey: 'shell.shortcuts.nextTab' },
    ],
  },
  {
    titleKey: 'shell.shortcuts.groups.work',
    rows: [
      { combo: 'j', labelKey: 'shell.shortcuts.listDown' },
      { combo: 'k', labelKey: 'shell.shortcuts.listUp' },
      { combo: 'a', labelKey: 'shell.shortcuts.approve' },
      { combo: 'r', labelKey: 'shell.shortcuts.reject' },
      { combo: 's', labelKey: 'shell.shortcuts.snooze' },
      { combo: 'x', labelKey: 'shell.shortcuts.select' },
      { combo: 'e', labelKey: 'shell.shortcuts.openObject' },
      { combo: 'shift+?', labelKey: 'shell.shortcuts.cheatSheet' },
    ],
  },
  {
    titleKey: 'shell.shortcuts.groups.table',
    rows: [
      { combo: 'mod+v', labelKey: 'shell.shortcuts.pasteCells' },
      { combo: 'mod+z', labelKey: 'shell.shortcuts.undoEdit' },
      { combo: 'mod+shift+z', labelKey: 'shell.shortcuts.redoEdit' },
    ],
  },
]

export function ShortcutsOverlay({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('shell.status.shortcuts')}
        description={t('shell.shortcuts.layoutHint')}
        size="lg"
      >
        <div className="grid gap-6 sm:grid-cols-3">
          {GROUPS.map((group) => (
            <section key={group.titleKey}>
              <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                {t(group.titleKey)}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {group.rows.map((row) => (
                  <div key={row.combo} className="flex items-center justify-between gap-3">
                    <dt className="truncate text-sm text-fg-secondary">{t(row.labelKey)}</dt>
                    <dd className="shrink-0">
                      <Kbd>{formatShortcut(row.combo)}</Kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
