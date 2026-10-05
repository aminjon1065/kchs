#!/usr/bin/env node
/**
 * Таблицы — у владельцев и в тексте SQL (ADR-0184). Правила dependency-cruiser
 * (ADR-0178) видят импорт таблицы, но не её имя в шаблоне `sql` и не то, читает
 * модуль таблицу ядра или пишет. Этот скрипт ловит:
 *  - запись модуля в таблицу ядра — `.insert(t)`, `.update(t)`, `.delete(t)` Drizzle и
 *    `INSERT INTO`/`UPDATE`/`DELETE FROM` через `${t}`: таблицы ядра пишут только его
 *    сервисы, у них — версии объекта, события outbox, аудит и сброс кэшей, которые
 *    прямая запись обходит (так описание датасета не доходило до поиска, ADR-0170);
 *  - чужую таблицу по имени в тексте SQL (`FROM`, `JOIN`, `INSERT INTO`, `UPDATE`,
 *    `DELETE FROM`) — у модуля таблицу ядра или другого модуля, у ядра таблицу
 *    модуля: имя в тексте обходит правила владения. Чужие таблицы — через сервисы и
 *    публичные API, свои — подстановкой `${таблица}`.
 *
 *   node scripts/table-owners.mjs     проверка (часть `pnpm deps:check`)
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Осознанные исключения (ADR-0184). identity — модуль входа: он пишет в учётную
 * запись справочника столбцы входа и связи с каталогом (отметка входа, источник
 * входа, DN и время синхронизации LDAP/AD, ADR-0179); остальное о людях — через
 * сервисы справочника ядра.
 */
const ALLOWED = [{ module: 'identity', table: 'users' }]

/** Все `.ts` под каталогом, кроме тестов. */
function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')
const isSchema = (file) => file.endsWith(`${path.sep}schema.ts`)

/** Владелец файла: `kernel` или имя модуля; остальное (shared, сид, cli) — null. */
function ownerOf(name) {
  if (name.startsWith('src/kernel/')) return 'kernel'
  return /^src\/modules\/([^/]+)\//.exec(name)?.[1] ?? null
}

/** Таблицы из `schema.ts` ядра и модулей: имя экспорта и владелец по имени в БД. */
function tables() {
  const kernelExports = new Map()
  const owners = new Map()
  const definition = /export const (\w+)\s*=\s*(?:pgTable|\w+\.table)\(\s*'([a-z_0-9]+)'/g
  for (const file of [
    ...sources(path.join(ROOT, 'src/kernel')),
    ...sources(path.join(ROOT, 'src/modules')),
  ]) {
    if (!isSchema(file)) continue
    const owner = ownerOf(rel(file))
    for (const match of readFileSync(file, 'utf8').matchAll(definition)) {
      owners.set(match[2], owner)
      if (owner === 'kernel') kernelExports.set(match[1], match[2])
    }
  }
  return { kernelExports, owners }
}

/** Локальные имена таблиц ядра в файле: `import { a, b as c } from '~/kernel/x/schema.js'`. */
function importedKernelTables(text, kernelExports) {
  const local = new Map()
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*kernel\/[^']+\/schema\.js'/g
  for (const match of text.matchAll(imports)) {
    for (const part of match[1].split(',')) {
      const [name, alias] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
      if (name && kernelExports.has(name)) {
        local.set((alias ?? name).trim(), kernelExports.get(name))
      }
    }
  }
  return local
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function check() {
  const { kernelExports, owners } = tables()
  const violations = []

  for (const file of [
    ...sources(path.join(ROOT, 'src/kernel')),
    ...sources(path.join(ROOT, 'src/modules')),
  ]) {
    if (isSchema(file)) continue
    const name = rel(file)
    const owner = ownerOf(name)
    const text = readFileSync(file, 'utf8')
    const allowed = (table) => ALLOWED.some((rule) => rule.module === owner && rule.table === table)
    const report = (index, table, how) => {
      if (!allowed(table)) violations.push(`${name}:${lineOf(text, index)}  ${table}: ${how}`)
    }

    if (owner !== 'kernel') {
      const local = importedKernelTables(text, kernelExports)
      for (const match of text.matchAll(/\.(insert|update|delete)\(\s*(\w+)\s*\)/g)) {
        const table = local.get(match[2])
        if (table) report(match.index, table, `запись .${match[1]}()`)
      }
      const dml = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\$\{\s*(\w+)\s*\}/gi
      for (const match of text.matchAll(dml)) {
        const table = local.get(match[2])
        if (table) report(match.index, table, `запись ${match[1].replace(/\s+/g, ' ')}`)
      }
    }

    const byName =
      /\b(FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(?:public|ops)\.)?"?([a-z_0-9]+)"?/gi
    for (const match of text.matchAll(byName)) {
      const tableOwner = owners.get(match[2])
      if (tableOwner !== undefined && tableOwner !== owner) {
        const whose = tableOwner === 'kernel' ? 'ядра' : `модуля ${tableOwner}`
        report(
          match.index,
          match[2],
          `по имени в ${match[1].replace(/\s+/g, ' ')}, таблица ${whose}`,
        )
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `Таблицы мимо владельцев (ADR-0184) — запись в таблицы ядра только его сервисами, чужие таблицы — через сервисы и публичные API, свои — через \${таблица}:\n  ${violations.join('\n  ')}\n`,
    )
    process.exit(1)
  }
  process.stdout.write(
    `✔ таблицы ядра модули не пишут, чужих таблиц по имени нет (таблиц: ${owners.size}, из них ядра: ${kernelExports.size})\n`,
  )
}

check()
