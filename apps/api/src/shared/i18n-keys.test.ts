import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasKey } from '@kchs/i18n'
import { describe, expect, it } from 'vitest'

/**
 * Ключи словаря, которые сервер отдаёт интерфейсу вместе с данными: подписи кнопок и
 * заголовки дел Входящих, названия заданий расписания, подсказки. Проверка литералов web
 * их не видит, а без ключа интерфейс показал бы его сырым («schedules.jobs.…»).
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY_LITERAL = /\b(labelKey|titleKey|bodyKey|messageKey|hintKey)\s*:\s*'([a-zA-Z0-9_.]+)'/g

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

describe('ключи словаря в данных сервера', () => {
  it('каждый есть в основном словаре', () => {
    const found: string[] = []
    const missing: string[] = []
    for (const file of sources(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(KEY_LITERAL)) {
        const key = match[2] as string
        found.push(key)
        if (!hasKey(key, 'ru')) missing.push(`${relative(SRC, file)}: ${key}`)
      }
    }
    expect(found.length).toBeGreaterThan(100)
    expect(missing).toEqual([])
  })
})
