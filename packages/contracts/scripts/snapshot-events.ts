/**
 * Снимок каталога событий (ADR-0189): JSON Schema нагрузки каждого типа события и его версия —
 * `packages/contracts/snapshots/events.json`, одна строка на событие. Снимок хранится в git: по
 * нему видно в истории и на ревью, как меняются события, которые получают подписчики и
 * внешние системы через вебхуки, а проверка совместимости (`pnpm contracts:compat`) сравнивает
 * его с базовой веткой.
 *
 *   pnpm --filter @kchs/contracts snapshot:events           — перезаписать снимок
 *   pnpm --filter @kchs/contracts snapshot:events --check   — снимок не отстал от кода
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { EVENT_PAYLOADS, EVENT_TYPES, eventVersion } from '../src/events/catalog.js'
import { normalizeSchema, writeLines } from './snapshot-format.mjs'

const FILE = fileURLToPath(new URL('../snapshots/events.json', import.meta.url))

const entries: Record<string, unknown> = {}
for (const type of [...EVENT_TYPES].sort()) {
  const schema = z.toJSONSchema(EVENT_PAYLOADS[type], { io: 'output', unrepresentable: 'any' })
  entries[type] = { version: eventVersion(type), schema: normalizeSchema(schema) }
}
const text = writeLines(entries)

if (process.argv.includes('--check')) {
  let committed = ''
  try {
    committed = readFileSync(FILE, 'utf8')
  } catch {
    // снимка ещё нет
  }
  if (committed !== text) {
    process.stderr.write(
      'Снимок событий отстал от каталога: выполните `pnpm contracts:snapshot` и закоммитьте ' +
        'packages/contracts/snapshots/events.json (ADR-0189)\n',
    )
    process.exit(1)
  }
  process.stdout.write(`Снимок событий актуален: ${EVENT_TYPES.length} типов\n`)
} else {
  writeFileSync(FILE, text, 'utf8')
  process.stdout.write(`Снимок событий записан: ${EVENT_TYPES.length} типов\n`)
}
