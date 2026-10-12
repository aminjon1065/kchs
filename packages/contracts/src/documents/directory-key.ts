import { z } from 'zod'

/**
 * Стабильный ключ записи справочника документооборота — журнала, шаблона (ADR-0206,
 * вопрос N42). Название меняется, UUID в другой установке другой; пакет конфигурации
 * (ADR-0097) ссылается на запись ключом. Тот же вид, что у ключа типа документа.
 */
export const DirectoryKey = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'ключ: строчные латинские буквы, цифры и _, начинается с буквы')
export type DirectoryKey = z.infer<typeof DirectoryKey>

/** Латиница для русских и таджикских букв — для ключа по названию. */
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
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
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ғ: 'gh',
  ӣ: 'i',
  қ: 'q',
  ӯ: 'u',
  ҳ: 'h',
  ҷ: 'j',
}

/**
 * Ключ по названию: транслитерация, всё прочее — `_`. «Обращения граждан» →
 * `obrashcheniya_grazhdan`. Миграция заполнения ключей журналов делает то же в SQL.
 */
export function keyFromName(name: string, fallback = 'item'): string {
  const latin = [...name.toLowerCase()].map((char) => TRANSLIT[char] ?? char).join('')
  let key = latin
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '')
  if (/^[0-9]/.test(key)) key = `j_${key}`.slice(0, 60)
  return key.length >= 2 ? key : fallback
}
