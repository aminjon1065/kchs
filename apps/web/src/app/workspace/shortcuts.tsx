import { Dialog, DialogContent, formatShortcut, Kbd } from '@kchs/ui'
import { useT } from '../i18n.js'

interface ShortcutRow {
  combo: string
  labelKey: string
}

const GROUPS: Array<{ titleKey: string; rows: ShortcutRow[] }> = [
  {
    titleKey: 'Навигация',
    rows: [
      { combo: 'mod+k', labelKey: 'Палитра команд' },
      { combo: 'mod+b', labelKey: 'Навигатор' },
      { combo: 'mod+.', labelKey: 'Контекстная панель' },
      { combo: 'mod+j', labelKey: 'Нижняя панель' },
      { combo: 'g h', labelKey: 'Мой день' },
      { combo: 'g i', labelKey: 'Входящие' },
      { combo: 'g f', labelKey: 'Файлы' },
    ],
  },
  {
    titleKey: 'Вкладки',
    rows: [
      { combo: 'mod+t', labelKey: 'Новая вкладка' },
      { combo: 'mod+w', labelKey: 'Закрыть вкладку' },
      { combo: 'mod+shift+t', labelKey: 'Восстановить закрытую' },
      { combo: 'mod+\\', labelKey: 'Разделить панель' },
      { combo: 'mod+1', labelKey: 'Перейти к вкладке 1…9' },
      { combo: 'ctrl+tab', labelKey: 'Следующая вкладка' },
    ],
  },
  {
    titleKey: 'Работа',
    rows: [
      { combo: 'mod+s', labelKey: 'Сохранить' },
      { combo: '/', labelKey: 'Поиск в представлении' },
      { combo: 'j', labelKey: 'Вниз по списку' },
      { combo: 'k', labelKey: 'Вверх по списку' },
      { combo: 'enter', labelKey: 'Открыть' },
      { combo: 'a', labelKey: 'Согласовать (Входящие)' },
      { combo: 'r', labelKey: 'Отклонить (Входящие)' },
      { combo: 'shift+?', labelKey: 'Эта шпаргалка' },
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
        description="Сочетания сравниваются по коду клавиши — кириллическая раскладка не мешает"
        size="lg"
      >
        <div className="grid gap-6 sm:grid-cols-3">
          {GROUPS.map((group) => (
            <section key={group.titleKey}>
              <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                {group.titleKey}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {group.rows.map((row) => (
                  <div key={row.combo} className="flex items-center justify-between gap-3">
                    <dt className="truncate text-sm text-fg-secondary">{row.labelKey}</dt>
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
