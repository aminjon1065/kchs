/** Кириллица (русская и таджикская) → латиница для ключей и адресов. */
const LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ӣ: 'i',
  ӯ: 'u',
  ҳ: 'h',
  ҷ: 'j',
  қ: 'q',
  ғ: 'g',
}

export function transliterate(value: string): string {
  return value
    .toLowerCase()
    .split('')
    .map((char) => LATIN[char] ?? char)
    .join('')
}

/** Ключ пространства: латиница, цифры и дефис. */
export function toSlug(value: string, max = 32): string {
  return transliterate(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
}

/** Ключ поля датасета: snake_case латиницей, не с цифры (как в `FieldDef.key`). */
export function toFieldKey(value: string): string {
  const key = transliterate(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (/^[0-9]/.test(key) ? `f_${key}` : key).slice(0, 64)
}
