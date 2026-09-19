import { addDays, weekdayOf } from './time.js'

/**
 * Быстрое создание из палитры (12-calendar-notifications-home.md §1):
 * «Встреча завтра в 10 с Ивановым» → название, дата, время, участники.
 * Слова языка — из словаря (`calendar.quick.vocab.*`): разбор один, язык —
 * данные, поэтому в коде нет русских слов, а английский работает так же.
 */
export interface QuickVocab {
  today: string[]
  tomorrow: string[]
  dayAfterTomorrow: string[]
  /** Понедельник…воскресенье: начала слов («пн», «понедельн»). */
  weekdays: string[][]
  /** Январь…декабрь: начала слов («янв», «январ»). */
  months: string[][]
  /** Предлог времени и дня: «в», «во». */
  at: string[]
  /** «с» — и участники, и начало промежутка. */
  with: string[]
  /** «до» — конец промежутка. */
  until: string[]
  /** «на» — длительность. */
  for: string[]
  /** «и» — между участниками. */
  and: string[]
  minutes: string[]
  hours: string[]
  /** «час» без числа — один час. */
  oneHour: string[]
  halfHour: string[]
  /** Часы утра («9 утра»). */
  morning: string[]
  /** Часы после полудня («3 дня», «7 вечера»). */
  afternoon: string[]
  allDay: string[]
  /** Окончания косвенных падежей фамилий («ым», «ой»), по убыванию длины. */
  nameEndings: string[]
  defaultTitle: string
}

/** Словарь из строк i18n: варианты через `|`, у дней и месяцев — группы через `;`. */
export function vocabFrom(t: (key: string) => string): QuickVocab {
  const list = (key: string) =>
    t(`calendar.quick.vocab.${key}`)
      .split('|')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  const groups = (key: string) =>
    t(`calendar.quick.vocab.${key}`)
      .split(';')
      .map((group) =>
        group
          .split('|')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      )
  return {
    today: list('today'),
    tomorrow: list('tomorrow'),
    dayAfterTomorrow: list('dayAfterTomorrow'),
    weekdays: groups('weekdays'),
    months: groups('months'),
    at: list('at'),
    with: list('with'),
    until: list('until'),
    for: list('for'),
    and: list('and'),
    minutes: list('minutes'),
    hours: list('hours'),
    oneHour: list('oneHour'),
    halfHour: list('halfHour'),
    morning: list('morning'),
    afternoon: list('afternoon'),
    allDay: list('allDay'),
    nameEndings: list('nameEndings').sort((a, b) => b.length - a.length),
    defaultTitle: t('calendar.quick.vocab.defaultTitle'),
  }
}

export interface QuickEvent {
  title: string
  date: string | null
  /** Минуты от полуночи. */
  start: number | null
  end: number | null
  allDay: boolean
  /** Начала фамилий для поиска сотрудников («Иванов» из «Ивановым»). */
  people: string[]
}

const TIME_RE = /^(\d{1,2})(?:[:.](\d{2}))?$/
const RANGE_RE = /^(\d{1,2})(?:[:.](\d{2}))?[-–—](\d{1,2})(?:[:.](\d{2}))?$/
const DATE_RE = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/

function clockOf(hours: string, minutes: string | undefined): number | null {
  const h = Number(hours)
  const m = minutes === undefined ? 0 : Number(minutes)
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

const clean = (token: string) => token.toLowerCase().replace(/[,.;!?]+$/, '')
const startsWithAny = (word: string, prefixes: string[]) =>
  prefixes.some((prefix) => word.startsWith(prefix))

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Разбор фразы. `null` — во фразе нет ни даты, ни времени: это обычный поиск,
 * а не создание события.
 */
export function parseQuickEvent(text: string, today: string, vocab: QuickVocab): QuickEvent | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const used = new Array<boolean>(tokens.length).fill(false)
  let date: string | null = null
  let start: number | null = null
  let end: number | null = null
  let duration: number | null = null
  let allDay = false
  const people: string[] = []
  const year = Number(today.slice(0, 4))

  const take = (...indexes: number[]) => {
    for (const index of indexes) used[index] = true
  }
  const word = (index: number) => clean(tokens[index] ?? '')

  /** Время с поправкой «утра / дня / вечера» в следующем слове. */
  const timeAt = (index: number): { minute: number; size: number } | null => {
    const match = TIME_RE.exec(word(index))
    if (!match) return null
    let minute = clockOf(match[1] ?? '', match[2])
    if (minute === null) return null
    const next = word(index + 1)
    if (next && startsWithAny(next, vocab.afternoon) && minute < 12 * 60) {
      return { minute: minute + 12 * 60, size: 2 }
    }
    if (next && startsWithAny(next, vocab.morning)) return { minute, size: 2 }
    // «в 3» без уточнения — рабочий день: 1…7 — после полудня
    if (!match[2] && minute >= 60 && minute < 8 * 60) minute += 12 * 60
    return { minute, size: 1 }
  }

  for (let index = 0; index < tokens.length; index++) {
    if (used[index]) continue
    const current = word(index)

    // «весь день»
    const pair = `${current} ${word(index + 1)}`
    if (vocab.allDay.includes(pair) || vocab.allDay.includes(current)) {
      allDay = true
      take(index, ...(vocab.allDay.includes(pair) ? [index + 1] : []))
      continue
    }
    // сегодня / завтра / послезавтра
    if (vocab.today.includes(current)) {
      date = today
      take(index)
      continue
    }
    if (vocab.tomorrow.includes(current)) {
      date = addDays(today, 1)
      take(index)
      continue
    }
    if (vocab.dayAfterTomorrow.includes(current)) {
      date = addDays(today, 2)
      take(index)
      continue
    }
    // «в понедельник», «пт»
    const dayWord = vocab.at.includes(current) ? word(index + 1) : current
    const weekday = vocab.weekdays.findIndex((prefixes) =>
      prefixes.some(
        (prefix) => dayWord === prefix || (prefix.length > 2 && dayWord.startsWith(prefix)),
      ),
    )
    if (weekday >= 0 && dayWord) {
      const target = (weekday + 1) % 7
      const shift = (target - weekdayOf(today) + 7) % 7
      date = addDays(today, shift)
      take(index, ...(dayWord !== current ? [index + 1] : []))
      continue
    }
    // «25.09», «25.09.2026»
    const numeric = DATE_RE.exec(current)
    if (numeric) {
      const y = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : year
      const parsed = validDate(y, Number(numeric[2]), Number(numeric[1]))
      if (parsed) {
        date = parsed
        take(index)
        continue
      }
    }
    // «25 сентября»
    if (/^\d{1,2}$/.test(current)) {
      const month = vocab.months.findIndex((prefixes) => startsWithAny(word(index + 1), prefixes))
      if (month >= 0 && word(index + 1)) {
        const parsed = validDate(year, month + 1, Number(current))
        if (parsed) {
          date = parsed < today ? validDate(year + 1, month + 1, Number(current)) : parsed
          take(index, index + 1)
          continue
        }
      }
    }
    // «с 14 до 15» и «с Ивановым»
    if (vocab.with.includes(current)) {
      const from = timeAt(index + 1)
      if (from && vocab.until.includes(word(index + 1 + from.size))) {
        const to = timeAt(index + 2 + from.size)
        if (to) {
          start = from.minute
          end = to.minute
          take(...Array.from({ length: 2 + from.size + to.size }, (_, offset) => index + offset))
          continue
        }
      }
      // Участники: слова с заглавной буквы через «и» и запятые
      let cursor = index + 1
      const names: string[] = []
      while (cursor < tokens.length) {
        const raw = (tokens[cursor] ?? '').replace(/[,.;!?]+$/, '')
        if (/^\p{Lu}/u.test(raw)) {
          names.push(raw)
          cursor++
          if (/,$/.test(tokens[cursor - 1] ?? '')) continue
          if (vocab.and.includes(word(cursor)) && /^\p{Lu}/u.test(tokens[cursor + 1] ?? '')) {
            cursor++
            continue
          }
          break
        }
        break
      }
      if (names.length > 0) {
        for (const name of names) people.push(stemName(name, vocab.nameEndings))
        take(...Array.from({ length: cursor - index }, (_, offset) => index + offset))
        continue
      }
    }
    // «в 10», «в 9:30», «в 3 дня»
    if (vocab.at.includes(current)) {
      const time = timeAt(index + 1)
      if (time) {
        start = time.minute
        take(...Array.from({ length: 1 + time.size }, (_, offset) => index + offset))
        continue
      }
    }
    // «14-15», «10:00–11:30»
    const range = RANGE_RE.exec(current)
    if (range) {
      const from = clockOf(range[1] ?? '', range[2])
      const to = clockOf(range[3] ?? '', range[4])
      if (from !== null && to !== null && to > from) {
        start = from
        end = to
        take(index)
        continue
      }
    }
    // «10:30» без предлога
    if (/^\d{1,2}[:]\d{2}$/.test(current)) {
      const time = timeAt(index)
      if (time) {
        start = time.minute
        take(...Array.from({ length: time.size }, (_, offset) => index + offset))
        continue
      }
    }
    // «на 30 минут», «на 2 часа», «на час», «на полчаса»
    if (vocab.for.includes(current)) {
      const next = word(index + 1)
      if (vocab.oneHour.includes(next)) {
        duration = 60
        take(index, index + 1)
        continue
      }
      if (vocab.halfHour.includes(next)) {
        duration = 30
        take(index, index + 1)
        continue
      }
      if (/^\d+$/.test(next)) {
        const unit = word(index + 2)
        if (startsWithAny(unit, vocab.minutes)) {
          duration = Number(next)
          take(index, index + 1, index + 2)
          continue
        }
        if (startsWithAny(unit, vocab.hours)) {
          duration = Number(next) * 60
          take(index, index + 1, index + 2)
        }
      }
    }
  }

  if (date === null && start === null && !allDay) return null
  if (start !== null && end === null && duration !== null) end = Math.min(24 * 60, start + duration)
  const title = tokens
    .filter((_, index) => !used[index])
    .join(' ')
    .replace(/[,;]+$/, '')
    .trim()
  return {
    title: title || vocab.defaultTitle,
    date: date ?? (start !== null ? today : null),
    start: allDay ? null : start,
    end: allDay ? null : end,
    allDay: allDay || (start === null && date !== null),
    people,
  }
}

/** Начало фамилии для поиска: без окончания косвенного падежа. */
export function stemName(name: string, endings: string[]): string {
  const lower = name.toLowerCase()
  for (const ending of endings) {
    if (lower.endsWith(ending) && lower.length - ending.length >= 3) {
      return name.slice(0, name.length - ending.length)
    }
  }
  return name
}
