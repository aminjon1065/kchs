import type { Executor } from '~/shared/db/client.js'
import { businessCalendar } from '~/shared/db/schema/index.js'

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
