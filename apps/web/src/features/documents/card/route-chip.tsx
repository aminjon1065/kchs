import type { LangText } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { cn, Tooltip } from '@kchs/ui'
import { Route } from 'lucide-react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useDocument } from './document-context.js'

function text(value: LangText | null | undefined, locale: string): string | null {
  if (!value) return null
  return (value as Record<string, string | undefined>)[locale] ?? value.ru
}

/**
 * Идущий маршрут чипом в шапке карточки (ADR-0230): текущий шаг и кто ждёт; просрочка —
 * тоном ошибки. Щелчок ведёт на вкладку «Маршрут», срок — в подсказке.
 */
export function DocumentRouteChip({ onOpen }: { onOpen?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const { document } = useDocument()
  const step = document.route?.steps[0]
  if (!document.route || !step) return null
  const name = text(step.name, locale) ?? text(document.route.name, locale) ?? ''
  const names = step.pending.map((user) => user.displayName).join(', ')
  const label = names ? t('documents.header.routeStep', { step: name, names }) : name
  // Шаг с длинным названием и списком ждущих не вытесняет тему документа:
  // подпись обрезается, целиком — в подсказке
  const chip = cn(
    'inline-flex h-6 min-w-0 max-w-80 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
    step.overdue ? 'bg-danger-subtle text-danger' : 'bg-accent-subtle text-accent',
  )
  const content = (
    <>
      <Route className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </>
  )
  return (
    <Tooltip
      content={
        step.dueAt
          ? `${label} · ${t('documents.route.dueShort', { date: formatDateTime(step.dueAt, { locale }) })}`
          : label
      }
    >
      {onOpen ? (
        <button type="button" onClick={onOpen} className={chip}>
          {content}
        </button>
      ) : (
        <span className={chip}>{content}</span>
      )}
    </Tooltip>
  )
}
