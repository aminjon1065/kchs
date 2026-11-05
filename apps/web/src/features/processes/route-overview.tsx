import type { LangText } from '@kchs/contracts'
import { formatDateTime, formatDuration } from '@kchs/fields'
import type { ProcessInstanceView } from '@kchs/process'
import { cn, RouteStepper, type RouteStepperStep } from '@kchs/ui'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { type OverviewStep, routeOverviewOf } from './route-overview-model.js'

const MINUTE = 60_000

function text(value: LangText | null | undefined, locale: string): string | null {
  if (!value) return null
  return (value as Record<string, string | undefined>)[locale] ?? value.ru
}

function minutesBetween(from: string, to: string | Date): number {
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / MINUTE))
}

/** Время на часах дня: сегодня — «17:05», иначе дата и время. */
function clock(value: string, locale: string): string {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(locale === 'en' ? 'en-GB' : 'ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  return formatDateTime(value, { locale: locale as 'ru' })
}

/**
 * Маршрут объекта шагами (ADR-0230): шапка — название маршрута, «сроки в часах» у
 * экстренного и остаток времени, если шаг ждёт смотрящего; ниже — шаги с людьми,
 * временем прохождения, нормой и сроком текущего.
 */
export function RouteOverview({
  view,
  now = new Date(),
}: {
  view: ProcessInstanceView
  now?: Date
}) {
  const t = useT()
  const locale = useLocale()
  const overview = routeOverviewOf(view)

  const normOf = (step: OverviewStep): string | null =>
    step.normHours
      ? t('processes.overview.normHours', { count: step.normHours })
      : step.normWorkingDays
        ? t('processes.overview.normDays', { count: step.normWorkingDays })
        : null

  const steps: RouteStepperStep[] = overview.steps.map((step) => {
    const names = step.people.map((user) => user.displayName).join(', ')
    const people = step.mine
      ? t('processes.overview.mineNames', { names })
      : names || (step.state === 'upcoming' ? null : t('processes.line.unassigned'))
    const title = text(step.name, locale) ?? t(`processes.types.${step.type}`)
    const norm = normOf(step)
    if (step.state === 'done' && step.activatedAt && step.completedAt) {
      const took = t('processes.overview.took', {
        duration: formatDuration(minutesBetween(step.activatedAt, step.completedAt), { locale }),
      })
      const late = step.dueAt ? new Date(step.completedAt) > new Date(step.dueAt) : false
      return {
        key: step.key,
        title,
        people: names ? `${names} · ${clock(step.completedAt, locale)}` : people,
        meta: norm ? `${took} · ${norm}` : took,
        metaTone: late ? 'danger' : 'success',
        state: 'done',
      }
    }
    if (step.state === 'rejected' && step.completedAt) {
      return {
        key: step.key,
        title,
        people,
        meta: t('processes.overview.rejected', {
          date: formatDateTime(step.completedAt, { locale }),
        }),
        metaTone: 'danger',
        state: 'rejected',
      }
    }
    if (step.state === 'current') {
      return {
        key: step.key,
        title,
        people,
        meta: step.dueAt
          ? step.overdue
            ? t('processes.overview.overdue', {
                duration: formatDuration(minutesBetween(step.dueAt, now), { locale }),
              })
            : t('processes.overview.until', { time: clock(step.dueAt, locale) })
          : norm,
        metaTone: step.overdue ? 'danger' : step.mine ? 'accent' : 'muted',
        state: 'current',
      }
    }
    return { key: step.key, title, people, meta: norm, metaTone: 'muted', state: step.state }
  })

  const mine = overview.mine
  const remaining =
    mine?.dueAt && !mine.overdue
      ? formatDuration(minutesBetween(now.toISOString(), mine.dueAt), { locale })
      : null
  const mineNorm = mine ? normOf(mine) : null

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-2xs uppercase tracking-wider text-fg-muted">
          {overview.hours
            ? t('processes.overview.titleHours', {
                name: text(view.name, locale) ?? view.definitionKey,
              })
            : t('processes.overview.title', {
                name: text(view.name, locale) ?? view.definitionKey,
              })}
        </span>
        {mine ? (
          <span
            className={cn(
              'tabular font-mono text-2xs uppercase tracking-wider',
              mine.overdue ? 'text-danger' : 'text-accent',
            )}
          >
            {mine.overdue
              ? t('processes.overview.mineOverdue')
              : remaining && mineNorm
                ? t('processes.overview.mineLeftOf', { left: remaining, norm: mineNorm })
                : remaining
                  ? t('processes.overview.mineLeft', { left: remaining })
                  : t('processes.overview.mine')}
          </span>
        ) : null}
      </div>
      {steps.length > 0 ? (
        <RouteStepper steps={steps} aria-label={t('processes.overview.label')} />
      ) : (
        <p className="text-sm text-fg-muted">{t('processes.overview.empty')}</p>
      )}
    </div>
  )
}
