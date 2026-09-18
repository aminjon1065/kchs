import { Button, Checkbox, Dialog, DialogContent, IconButton, useToast } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { HOME_WIDGETS, HOME_WIDGETS_PREFERENCE, type HomeWidget } from './widgets.js'

interface Row {
  widget: HomeWidget
  shown: boolean
}

/** Показанные — в своём порядке, скрытые — следом, чтобы их можно было вернуть. */
const rowsOf = (current: HomeWidget[]): Row[] => [
  ...current.map((widget) => ({ widget, shown: true })),
  ...HOME_WIDGETS.filter((widget) => !current.includes(widget)).map((widget) => ({
    widget,
    shown: false,
  })),
]

/**
 * Настройка «Мой день» (P0-E15 S01): что показывать и в каком порядке.
 * Выбор хранится в настройках пользователя; «Набор по умолчанию» удаляет
 * настройку — снова действует набор по роли.
 */
export function HomeSettingsDialog({
  open,
  onOpenChange,
  current,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: HomeWidget[]
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const idPrefix = useId()
  const [rows, setRows] = useState<Row[]>(() => rowsOf(current))

  // Каждое открытие начинается с того, что сейчас на экране
  const currentKey = current.join(',')
  useEffect(() => {
    if (open) setRows(rowsOf(currentKey ? (currentKey.split(',') as HomeWidget[]) : []))
  }, [open, currentKey])

  const save = useMutation({
    mutationFn: (value: HomeWidget[] | null) =>
      http.put('/me/preferences', { key: HOME_WIDGETS_PREFERENCE, value }),
    onSuccess: () => {
      toast.show({ title: t('home.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: keys.me })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const move = (index: number, step: -1 | 1) =>
    setRows((list) => {
      const next = [...list]
      const target = index + step
      const [row] = next.splice(index, 1)
      if (!row || target < 0 || target > list.length - 1) return list
      next.splice(target, 0, row)
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('home.customizeTitle')}
        description={t('home.customizeHint')}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={save.isPending}
              onClick={() => save.mutate(null)}
            >
              {t('home.resetToRole')}
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => save.mutate(rows.filter((row) => row.shown).map((row) => row.widget))}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          {rows.map((row, index) => {
            const name = t(`home.widgets.${row.widget}`)
            return (
              <li key={row.widget} className="flex items-center gap-2 px-3 py-1.5">
                <Checkbox
                  id={`${idPrefix}-${row.widget}`}
                  label={name}
                  checked={row.shown}
                  onCheckedChange={(next) =>
                    setRows((list) =>
                      list.map((item) =>
                        item.widget === row.widget ? { ...item, shown: next === true } : item,
                      ),
                    )
                  }
                />
                <span className="flex-1" />
                <IconButton
                  size="sm"
                  label={t('home.moveUp', { name })}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton
                  size="sm"
                  label={t('home.moveDown', { name })}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </IconButton>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
