import type { BusinessCalendarYear, BusinessDayKind } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import type { MiniCalendarMark } from '@kchs/ui'
import { useQueries } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { businessYearQuery } from './queries.js'
import { weekdayOf } from './time.js'

/** День сетки по производственному календарю: приглушён ли и что подписать. */
export interface DayInfo {
  muted: boolean
  note: string | null
  mark: MiniCalendarMark | null
}

/**
 * Праздники, перенесённые выходные и рабочие субботы для дней вида
 * (`GET /business-calendar?year=`): нерабочие дни приглушены, праздник подписан.
 */
export function useBusinessDays(days: string[]): {
  info: (day: string) => DayInfo
  marks: Record<string, MiniCalendarMark>
} {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const years = [...new Set(days.map((day) => Number(day.slice(0, 4))))].sort()
  const combine = useCallback(
    (results: Array<{ data?: BusinessCalendarYear | undefined }>) => {
      const map = new Map<string, { kind: BusinessDayKind; note: string | null }>()
      for (const result of results) {
        for (const day of result.data?.days ?? []) {
          map.set(day.day, {
            kind: day.kind,
            note: day.note ? localizedText(day.note, locale) : null,
          })
        }
      }
      return map
    },
    [locale],
  )
  const byDay = useQueries({ queries: years.map((year) => businessYearQuery(year)), combine })

  const marks = useMemo(() => {
    const result: Record<string, MiniCalendarMark> = {}
    for (const [day, item] of byDay) result[day] = item.kind
    return result
  }, [byDay])

  const info = useCallback(
    (day: string): DayInfo => {
      const item = byDay.get(day)
      const weekday = weekdayOf(day)
      const weekend = weekday === 0 || weekday === 6
      const kind = item?.kind ?? null
      const muted =
        kind === 'holiday' || kind === 'weekend' || (weekend && kind !== 'work' && kind !== 'short')
      const note =
        kind === 'holiday'
          ? (item?.note ?? t('calendar.business.holiday'))
          : kind === 'weekend'
            ? (item?.note ?? t('calendar.business.transferred'))
            : kind === 'work'
              ? (item?.note ?? t('calendar.business.workday'))
              : kind === 'short'
                ? (item?.note ?? t('calendar.business.short'))
                : null
      return { muted, note, mark: kind }
    },
    [byDay, t],
  )

  return { info, marks }
}
