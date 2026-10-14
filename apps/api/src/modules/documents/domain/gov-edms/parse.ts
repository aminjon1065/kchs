/**
 * Реквизиты из текста документа, выгруженного из госЭДО (ADR-0219): номер и дата у
 * отправителя, отправитель, тема. Это подсказка, а не разбор по стандарту: шаблоны
 * покрывают обычный бланк письма на русском и таджикском; что не нашлось — останется
 * пустым, и его впишет делопроизводитель. ИИ здесь не нужен (он выключен на установке).
 */
export interface ParsedRequisites {
  externalNumber: string | null
  externalDate: string | null
  sender: string | null
  subject: string | null
}

/** Шапка письма — первые строки: отправитель и номер ищутся только в ней. */
const HEADER_LINES = 30
/** Тема ищется дальше — после шапки и адресата. */
const SUBJECT_LINES = 80

const MONTHS: Record<string, number> = {
  // Русские — в родительном падеже, как в датах писем
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
  // Таджикские — с изафетом (январи) и без него
  январ: 1,
  январи: 1,
  феврал: 2,
  феврали: 2,
  март: 3,
  марти: 3,
  апрел: 4,
  апрели: 4,
  май: 5,
  майи: 5,
  июн: 6,
  июни: 6,
  июл: 7,
  июли: 7,
  август: 8,
  августи: 8,
  сентябр: 9,
  сентябри: 9,
  октябр: 10,
  октябри: 10,
  ноябр: 11,
  ноябри: 11,
  декабр: 12,
  декабри: 12,
}

/** Слова, по которым строка шапки похожа на название ведомства. */
const ORGANIZATION =
  /(министерств|комитет|агентств|служб|управлени|департамент|администраци|хукумат|ҳукумат|вазорат|кумита|кӯмита|агентии|хадамот|раёсат|сарраёсат|муассиса|ministry|committee|agency|service|department)/i

/** Номер: «№ 12-3/45», «Исх. № 01/1234», «No 77», «рақами 12/3». */
const NUMBER =
  /(?:№|N[o°º]\.?|рақами|раками|шумораи)\s*([0-9A-Za-zА-Яа-яЁёӢӣҚқҒғҲҳҶҷӮӯ][0-9A-Za-zА-Яа-яЁёӢӣҚқҒғҲҳҶҷӮӯ/\-.]*[0-9A-Za-zА-Яа-яЁё]|\d)/u

const NUMERIC_DATE = /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/
const WORD_DATE = /«?(\d{1,2})»?\s+([А-Яа-яЁёӢӣҚқҒғҲҳҶҷӮӯ]+)\s+(\d{4})/
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/

/** Тема: «О проведении…», «Об утверждении…», «Дар бораи…», «Оид ба…», «Тема: …». */
const SUBJECT_PREFIX = /^(?:о|об|обо|дар\s+бораи|оид\s+ба|тема\s*:|мавзӯъ\s*:|мавзуъ\s*:)\s*\S/i

function isoDate(year: number, month: number, day: number): string | null {
  const fullYear = year < 100 ? 2000 + year : year
  if (fullYear < 1980 || fullYear > 2100 || month < 1 || month > 12 || day < 1) return null
  const date = new Date(Date.UTC(fullYear, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

/** Дата из куска текста: числовая, словами или ISO; `null` — дата не распознана. */
export function parseDate(text: string): string | null {
  const iso = ISO_DATE.exec(text)
  if (iso) {
    const value = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    if (value) return value
  }
  const word = WORD_DATE.exec(text)
  if (word) {
    const month = MONTHS[(word[2] ?? '').toLowerCase()]
    if (month) {
      const value = isoDate(Number(word[3]), month, Number(word[1]))
      if (value) return value
    }
  }
  const numeric = NUMERIC_DATE.exec(text)
  if (numeric) {
    const value = isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]))
    if (value) return value
  }
  return null
}

function cleanLines(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t  ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
}

function trimNumber(value: string): string {
  return value.replace(/[.,;:]+$/, '').slice(0, 120)
}

/** Номер и дата из строки вида «№ 12/34 от 01.02.2026» или из шапки по отдельности. */
function numberAndDate(header: string[]): { number: string | null; date: string | null } {
  let number: string | null = null
  let date: string | null = null
  for (const line of header) {
    const found = NUMBER.exec(line)
    if (found?.[1] && !number) {
      number = trimNumber(found[1])
      // Дата в той же строке после номера — «№ 12 от 01.02.2026», «аз 01.02.2026»
      const rest = line.slice((found.index ?? 0) + found[0].length)
      date = parseDate(rest) ?? date
    }
    if (number && date) break
  }
  if (!date) {
    for (const line of header) {
      if (
        /(^|\s)(от|аз|дата|санаи)\s/i.test(line) ||
        NUMERIC_DATE.test(line) ||
        WORD_DATE.test(line) ||
        ISO_DATE.test(line)
      ) {
        date = parseDate(line)
        if (date) break
      }
    }
  }
  return { number, date }
}

function senderOf(header: string[]): string | null {
  const line = header.find((item) => ORGANIZATION.test(item) && item.length <= 300)
  if (!line) return null
  // Шапку бланка часто набирают прописными — оставляем как есть, только без лишних знаков
  return line.replace(/^[\s"«]+|[\s"».,]+$/g, '') || null
}

function subjectOf(lines: string[]): string | null {
  const index = lines.findIndex((line) => SUBJECT_PREFIX.test(line))
  if (index < 0) return null
  const first = lines[index] ?? ''
  const parts = [first.replace(/^(?:тема|мавзӯъ|мавзуъ)\s*:\s*/i, '')]
  // Тема бывает в две-три строки: продолжение — со строчной буквы, без точки в конце первой
  for (const next of lines.slice(index + 1, index + 3)) {
    if (/[.!?:]$/.test(parts[parts.length - 1] ?? '') || !/^[a-zа-яёӣқғҳҷӯ]/.test(next)) break
    parts.push(next)
  }
  const subject = parts.join(' ').trim()
  return subject.length > 0 ? subject.slice(0, 500) : null
}

export function parseRequisites(text: string): ParsedRequisites {
  const lines = cleanLines(text)
  const header = lines.slice(0, HEADER_LINES)
  const { number, date } = numberAndDate(header)
  return {
    externalNumber: number,
    externalDate: date,
    sender: senderOf(header),
    subject: subjectOf(lines.slice(0, SUBJECT_LINES)),
  }
}
