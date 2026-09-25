#!/usr/bin/env node
/**
 * Бюджет оболочки (04-verification.md: «бандл оболочки ≤ 400 КБ gz, модули лениво»; ADR-0166):
 * сумма gzip основного чанка и модулей, которые index.html предзагружает. Экраны, словари
 * tg/en и вход грузятся отдельно и в бюджет не входят.
 *
 *   pnpm --filter @kchs/web build && pnpm --filter @kchs/web budget
 *   KCHS_SHELL_BUDGET_KB=420 pnpm --filter @kchs/web budget   # другой предел
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const LIMIT_KB = Number(process.env.KCHS_SHELL_BUDGET_KB ?? 400)

const html = readFileSync(path.join(DIST, 'index.html'), 'utf8')
const tags = html.match(/<(script|link)\b[^>]*>/g) ?? []
const files = new Set()
for (const tag of tags) {
  const isModule = /\btype="module"/.test(tag) || /\brel="modulepreload"/.test(tag)
  const url = /\b(?:src|href)="\/(assets\/[^"]+\.js)"/.exec(tag)?.[1]
  if (isModule && url) files.add(url)
}
if (files.size === 0) {
  process.stderr.write(
    `В ${path.join(DIST, 'index.html')} нет модулей: сначала pnpm --filter @kchs/web build\n`,
  )
  process.exit(1)
}

// Килобайты десятичные — так же, как в ADR-0166 и 04-verification.md
const kb = (bytes) => (bytes / 1000).toFixed(1).padStart(7)
let total = 0
for (const file of files) {
  const size = gzipSync(readFileSync(path.join(DIST, file)), { level: 9 }).length
  total += size
  process.stdout.write(`${kb(size)} КБ  ${file}\n`)
}
process.stdout.write(`${kb(total)} КБ  всего, бюджет ${LIMIT_KB} КБ\n`)
if (total > LIMIT_KB * 1000) {
  process.stderr.write(
    'Оболочка превысила бюджет: вынесите экран или диалог в отдельный чанк (lazy) — ADR-0166\n',
  )
  process.exit(1)
}
