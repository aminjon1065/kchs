import type {
  BusinessCalendarYear,
  BusinessDay,
  BusinessDayInput,
  BusinessDayKind,
} from '@kchs/contracts'
import { and, asc, between, eq } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { businessCalendar } from '~/shared/db/schema/index.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { publishEvent } from '../events/publisher.js'
import {
  countWorkingDays,
  type DayKindOf,
  endOfLocalDay,
  isWorkingDate,
  localDate,
  shiftWorkingDays,
} from './working-days.js'

/**
 * Производственный календарь (01-vision.md A3: «производственный календарь РТ»).
 * В календаре хранятся только исключения из правила «понедельник–пятница —
 * рабочие дни»: праздники, перенесённые выходные и рабочие субботы.
 */
export const DEFAULT_COUNTRY = 'TJ'

interface FixedHoliday {
  month: number
  day: number
  note: { ru: string; tg: string; en: string }
}

/**
 * Праздники Республики Таджикистан с постоянной датой (Трудовой кодекс РТ).
 * Иди Рамазон и Иди Қурбон и переносы выходных объявляются постановлением
 * Правительства каждый год — их вносит администратор.
 */
export const TJ_FIXED_HOLIDAYS: FixedHoliday[] = [
  { month: 1, day: 1, note: { ru: 'Новый год', tg: 'Соли нав', en: "New Year's Day" } },
  { month: 3, day: 8, note: { ru: 'День матери', tg: 'Рӯзи Модар', en: "Mother's Day" } },
  ...[21, 22, 23, 24].map((day) => ({
    month: 3,
    day,
    note: { ru: 'Навруз', tg: 'Наврӯз', en: 'Navruz' },
  })),
  {
    month: 5,
    day: 1,
    note: {
      ru: 'Международный день солидарности трудящихся',
      tg: 'Рӯзи байналмилалии якдилии меҳнаткашон',
      en: "International Workers' Day",
    },
  },
  { month: 5, day: 9, note: { ru: 'День Победы', tg: 'Рӯзи Ғалаба', en: 'Victory Day' } },
  {
    month: 6,
    day: 27,
    note: {
      ru: 'День национального единства',
      tg: 'Рӯзи Ваҳдати миллӣ',
      en: 'National Unity Day',
    },
  },
  {
    month: 9,
    day: 9,
    note: {
      ru: 'День государственной независимости',
      tg: 'Рӯзи Истиқлолияти давлатӣ',
      en: 'Independence Day',
    },
  },
  {
    month: 11,
    day: 6,
    note: { ru: 'День Конституции', tg: 'Рӯзи Конститутсия', en: 'Constitution Day' },
  },
]

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * Праздники с постоянной датой на указанные годы. Идемпотентно: существующие
 * дни (в том числе правленные администратором) не перезаписываются.
 * Возвращает число добавленных дней по годам.
 */
export async function seedFixedHolidays(
  tx: Executor,
  years: number[],
  country = DEFAULT_COUNTRY,
): Promise<Array<{ year: number; added: number }>> {
  const result: Array<{ year: number; added: number }> = []
  for (const year of years) {
    const inserted = await tx
      .insert(businessCalendar)
      .values(
        TJ_FIXED_HOLIDAYS.map((holiday) => ({
          country,
          day: `${year}-${pad(holiday.month)}-${pad(holiday.day)}`,
          kind: 'holiday',
          note: holiday.note,
        })),
      )
      .onConflictDoNothing()
      .returning({ day: businessCalendar.day })
    result.push({ year, added: inserted.length })
  }
  return result
}

// ─── Рабочие дни и сроки ─────────────────────────────────────────────────────

/**
 * Исключения календаря по годам — в памяти процесса ненадолго: сроки считаются
 * пачками (напоминания, эскалации), а правка календаря редкая. Своя правка
 * сбрасывает кэш сразу, чужая (другой процесс api/worker) — по истечении минуты.
 */
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; days: Map<string, BusinessDayKind> }>()

async function yearExceptions(
  country: string,
  year: number,
  executor: Executor,
): Promise<Map<string, BusinessDayKind>> {
  const key = `${country}:${year}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.days
  const rows = await executor
    .select({ day: businessCalendar.day, kind: businessCalendar.kind })
    .from(businessCalendar)
    .where(
      and(
        eq(businessCalendar.country, country),
        between(businessCalendar.day, `${year}-01-01`, `${year}-12-31`),
      ),
    )
  const days = new Map(rows.map((row) => [row.day, row.kind as BusinessDayKind]))
  cache.set(key, { at: Date.now(), days })
  return days
}

/**
 * Исключения на промежуток дат — синхронная `kindOf` для чистых функций.
 * Годы подгружаются заранее: сдвиг на N рабочих дней не уходит дальше
 * `N + 30` календарных дней (длинных праздничных цепочек больше не бывает).
 */
async function kindsFor(
  country: string,
  from: string,
  to: string,
  executor: Executor,
): Promise<DayKindOf> {
  const first = Number((from < to ? from : to).slice(0, 4))
  const last = Number((from < to ? to : from).slice(0, 4))
  const years = new Map<number, Map<string, BusinessDayKind>>()
  for (let year = first; year <= last; year++) {
    years.set(year, await yearExceptions(country, year, executor))
  }
  return (day) => years.get(Number(day.slice(0, 4)))?.get(day)
}

function span(from: string, workingDays: number): string {
  const days = Math.abs(workingDays) * 2 + 30
  const date = new Date(
    Date.parse(`${from}T00:00:00Z`) + Math.sign(workingDays || 1) * days * 86_400_000,
  )
  return date.toISOString().slice(0, 10)
}

export interface CalendarOptions {
  country?: string
  executor?: Executor
}

export interface DeadlineOptions extends CalendarOptions {
  /** Пояс, в котором считается «конец дня»; по умолчанию — пояс установки (`TZ`). */
  timezone?: string
}

/**
 * Производственный календарь для сроков (10-tasks-projects.md §4, контракт
 * ProcessDefinition: `dueWorkingDays`): рабочие дни, сдвиг на N рабочих дней,
 * срок «до конца N-го рабочего дня» в поясе установки. Правка дней — у
 * администратора системы, с событием и аудитом.
 */
export const BusinessCalendar = {
  async isWorkingDay(day: string, options: CalendarOptions = {}): Promise<boolean> {
    const country = options.country ?? DEFAULT_COUNTRY
    const kindOf = await kindsFor(country, day, day, options.executor ?? db())
    return isWorkingDate(day, kindOf)
  },

  /** N-й рабочий день после `from` (до него — при `n < 0`); `n = 0` — ближайший рабочий. */
  async addWorkingDays(from: string, n: number, options: CalendarOptions = {}): Promise<string> {
    const country = options.country ?? DEFAULT_COUNTRY
    const kindOf = await kindsFor(country, from, span(from, n), options.executor ?? db())
    return shiftWorkingDays(from, n, kindOf)
  },

  /**
   * Исключения календаря на промежуток дат одной загрузкой — для пачки сроков
   * (напоминания и эскалации поручений): дальше рабочие дни считают чистые
   * функции `working-days.ts` без обращений к базе.
   */
  async dayKinds(from: string, to: string, options: CalendarOptions = {}): Promise<DayKindOf> {
    const country = options.country ?? DEFAULT_COUNTRY
    return kindsFor(country, from, to, options.executor ?? db())
  },

  /** Рабочих дней в `(from, to]` (со знаком минус, если `to` раньше). */
  async workingDaysBetween(
    from: string,
    to: string,
    options: CalendarOptions = {},
  ): Promise<number> {
    const country = options.country ?? DEFAULT_COUNTRY
    const kindOf = await kindsFor(country, from, to, options.executor ?? db())
    return countWorkingDays(from, to, kindOf)
  },

  /**
   * Срок «N рабочих дней» от момента `start`: дата N-го рабочего дня после
   * календарной даты старта в поясе установки и конец этого дня. `N = 0` —
   * конец ближайшего рабочего дня (сегодняшнего, если он рабочий).
   */
  async deadline(
    start: Date,
    workingDays: number,
    options: DeadlineOptions = {},
  ): Promise<{ date: string; dueAt: Date }> {
    const timezone = options.timezone ?? config().TZ
    const date = await BusinessCalendar.addWorkingDays(
      localDate(start, timezone),
      Math.max(0, workingDays),
      options,
    )
    return { date, dueAt: endOfLocalDay(date, timezone) }
  },

  async year(year: number, options: CalendarOptions = {}): Promise<BusinessCalendarYear> {
    const country = options.country ?? DEFAULT_COUNTRY
    const rows = await (options.executor ?? db())
      .select()
      .from(businessCalendar)
      .where(
        and(
          eq(businessCalendar.country, country),
          between(businessCalendar.day, `${year}-01-01`, `${year}-12-31`),
        ),
      )
      .orderBy(asc(businessCalendar.day))
    const days: BusinessDay[] = rows.map((row) => ({
      day: row.day,
      kind: row.kind as BusinessDayKind,
      note: row.note ?? null,
    }))
    return { country, year, days }
  },

  /** Задать исключение дня: праздник, перенесённый выходной, рабочий или сокращённый день. */
  async setDay(
    tx: Executor,
    ctx: Ctx,
    day: string,
    input: BusinessDayInput,
    country = DEFAULT_COUNTRY,
  ): Promise<void> {
    await tx
      .insert(businessCalendar)
      .values({ country, day, kind: input.kind, note: input.note })
      .onConflictDoUpdate({
        target: [businessCalendar.country, businessCalendar.day],
        set: { kind: input.kind, note: input.note },
      })
    cache.delete(`${country}:${day.slice(0, 4)}`)
    await publishEvent(tx, ctx, {
      type: 'settings.business_calendar_changed',
      payload: { country, day, kind: input.kind },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.businessCalendarChanged,
        details: { country, day, kind: input.kind },
      },
      tx,
    )
  },

  /** Снять исключение: день снова по правилу недели. */
  async clearDay(tx: Executor, ctx: Ctx, day: string, country = DEFAULT_COUNTRY): Promise<boolean> {
    const removed = await tx
      .delete(businessCalendar)
      .where(and(eq(businessCalendar.country, country), eq(businessCalendar.day, day)))
      .returning({ day: businessCalendar.day })
    cache.delete(`${country}:${day.slice(0, 4)}`)
    if (removed.length === 0) return false
    await publishEvent(tx, ctx, {
      type: 'settings.business_calendar_changed',
      payload: { country, day, kind: null },
    })
    await audit(
      ctx,
      { action: AUDIT_ACTIONS.businessCalendarChanged, details: { country, day, kind: null } },
      tx,
    )
    return true
  },
}
