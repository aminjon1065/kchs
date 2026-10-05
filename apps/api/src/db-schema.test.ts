import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = path.dirname(fileURLToPath(import.meta.url))

/** Файлы схем владельцев: `kernel/<область>/schema.ts`, `modules/<модуль>/schema.ts`. */
function ownerSchemas(): string[] {
  const found: string[] = []
  for (const top of ['kernel', 'modules']) {
    for (const entry of readdirSync(path.join(SRC, top))) {
      const file = path.join(SRC, top, entry, 'schema.ts')
      if (statSync(path.join(SRC, top, entry)).isDirectory() && exists(file)) {
        found.push(`./${top}/${entry}/schema.js`)
      }
    }
  }
  return found.sort()
}

function exists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

describe('сборщик схемы (ADR-0178)', () => {
  it('включает схему каждого владельца — иначе drizzle-kit не увидит её таблиц', () => {
    const aggregator = readFileSync(path.join(SRC, 'db-schema.ts'), 'utf8')
    const exported = [...aggregator.matchAll(/^export \* from '([^']+)'$/gm)].map((m) => m[1])
    expect(exported).toEqual(expect.arrayContaining(ownerSchemas()))
    expect(exported).toContain('./shared/db/columns.js')
  })
})
