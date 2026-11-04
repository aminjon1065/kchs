/**
 * Ключи строк истории ЧС по содержанию (ADR-0229). Код строки разбора — порядковый номер в
 * году (`H2019-0007`, `D2022-012`): новая выгрузка с добавленной строкой сдвигает номера, и
 * сопоставление по коду теряло одни события и дублировало другие. Ключ собирается из полей,
 * которые уточнение сводки не меняет, и только из тех, что хранятся в датасете, — ключ уже
 * загруженных строк досчитывается из их значений, без миграции данных.
 */
export type Row = Record<string, unknown>

const EDGE_PUNCTUATION = /^[\s.,;:«»"'()–—-]+|[\s.,;:«»"'()–—-]+$/g

/** Текст для ключа: регистр, форма Unicode, пробелы и крайняя пунктуация строк не различают. */
export function normText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCTUATION, '')
}

/** Момент с точностью до минуты по UTC — одинаков у строки выгрузки и у строки базы. */
export function minuteOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const at = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(at.getTime()) ? normText(value) : at.toISOString().slice(0, 16)
}

/** Календарная дата `YYYY-MM-DD`: из строки выгрузки или из значения столбца `date`. */
export function dayOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

/**
 * Происшествие: когда (до минуты, с точностью даты), где (территория), что (вид как в
 * источнике, без него — код вида) и место. Число погибших и пострадавших, описание и
 * ущерб в ключ не входят — их уточняет новая выгрузка.
 */
export function incidentKey(row: Row): string {
  return [
    minuteOf(row.occurred_at),
    normText(row.date_precision),
    normText(row.territory),
    normText(row.type_raw) || normText(row.type_code),
    normText(row.place),
  ].join('|')
}

/** Акт оценки ущерба: документ, блок района в нём, дата бедствия и территория. */
export function actKey(row: Row): string {
  return [
    normText(row.origin),
    normText(row.place_raw),
    dayOf(row.event_date),
    normText(row.territory),
  ].join('|')
}

const collator = new Intl.Collator('ru', { numeric: true })

/**
 * Ключи с порядковым номером внутри группы неразличимых по содержанию строк (два схода
 * лавин в одном районе в один день): строки группы сопоставляются по порядку в источнике —
 * `origin` («файл, лист, строка N»), затем код.
 */
export function keyed<T extends Row>(rows: T[], keyOf: (row: T) => string): Map<string, T> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  const result = new Map<string, T>()
  for (const [key, group] of groups) {
    group.sort(
      (a, b) =>
        collator.compare(String(a.origin ?? ''), String(b.origin ?? '')) ||
        collator.compare(String(a.code ?? ''), String(b.code ?? '')),
    )
    group.forEach((row, index) => {
      result.set(`${key}#${index}`, row)
    })
  }
  return result
}

/**
 * Выдача свободных кодов для новых строк: код выгрузки, если он не занят, иначе следующий
 * номер того же года (`H2019-0003` при занятых `H2019-0001…0002`), а у кода без номера в
 * конце — суффикс `-2`, `-3`.
 */
export function codeAllocator(taken: Iterable<string>): (code: string) => string {
  const used = new Set<string>()
  const highest = new Map<string, { value: number; width: number }>()
  const SERIAL = /^(.*-)(\d+)$/
  const take = (code: string) => {
    used.add(code)
    const match = SERIAL.exec(code)
    if (!match) return
    const [, prefix = '', digits = ''] = match
    const current = highest.get(prefix)
    const value = Number(digits)
    if (!current || value > current.value) highest.set(prefix, { value, width: digits.length })
  }
  for (const code of taken) take(code)
  return (code: string) => {
    let next = code
    if (used.has(code)) {
      const match = SERIAL.exec(code)
      if (match) {
        const [, prefix = '', digits = ''] = match
        const top = highest.get(prefix) ?? { value: 0, width: digits.length }
        next = `${prefix}${String(top.value + 1).padStart(top.width, '0')}`
      } else {
        let suffix = 2
        while (used.has(`${code}-${suffix}`)) suffix += 1
        next = `${code}-${suffix}`
      }
    }
    take(next)
    return next
  }
}
