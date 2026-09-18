/**
 * Контракты для Python-движка: TypeScript-схемы — источник правды,
 * движок читает сгенерированные JSON-файлы (contracts/README.md).
 * Запуск: pnpm --filter @kchs/contracts gen:engine; CI проверяет, что результат закоммичен.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QUEUE_RUNTIME } from '../src/jobs/job.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '../../../apps/engine/kchs_engine/contracts')

function write(name: string, data: unknown): void {
  mkdirSync(outDir, { recursive: true })
  const body = {
    $comment:
      'Сгенерировано из packages/contracts командой `pnpm --filter @kchs/contracts gen:engine`. Не редактировать вручную.',
    ...(data as Record<string, unknown>),
  }
  writeFileSync(path.join(outDir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  process.stdout.write(`contracts → engine: ${name}\n`)
}

write('queues.json', { queues: QUEUE_RUNTIME })
