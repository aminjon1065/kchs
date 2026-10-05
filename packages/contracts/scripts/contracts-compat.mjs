#!/usr/bin/env node
/**
 * Совместимость контрактов (ADR-0189): снимки событий (`packages/contracts/snapshots/events.json`)
 * и OpenAPI (`apps/api/openapi.snapshot.json`) рабочего дерева сравниваются с базовой веткой.
 * Ломающее изменение роняет проверку:
 *  - событие или операция API удалены;
 *  - поле удалено или переименовано (переименование — удаление и новое поле);
 *  - тип поля сменился так, что прежние данные или прежние клиенты больше не подходят;
 *  - появилось обязательное поле (или прежнее стало обязательным) там, где данные шлют
 *    клиенты, — тело и параметры запроса, нагрузка события;
 *  - поле ответа или события стало необязательным, у ответа пропал успешный код.
 * Событие можно поломать только с повышением его версии в `EVENT_VERSIONS` (каталог событий);
 * операцию API — только записью в `snapshots/allowed-breaking.json` со ссылкой на ADR.
 * Добавочные изменения — новые события, операции, необязательные поля — проходят.
 *
 *   pnpm contracts:compat [--events] [--api]
 *   KCHS_CONTRACTS_BASE=<ref> — с чем сравнивать (по умолчанию — точка ответвления от origin/main)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compareApi, compareEvents } from './compat-core.mjs'

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const ROOT = git(['rev-parse', '--show-toplevel']).trim()
const EVENTS = 'packages/contracts/snapshots/events.json'
const API = 'apps/api/openapi.snapshot.json'
const ALLOWED = 'packages/contracts/snapshots/allowed-breaking.json'

const args = new Set(process.argv.slice(2))
const checkEvents = args.has('--events') || !args.has('--api')
const checkApi = args.has('--api') || !args.has('--events')

/**
 * База — точка ответвления от заданной ссылки, а не сама ссылка: иначе событие, добавленное в
 * main после ответвления ветки, выглядело бы удалённым в ней. Нулевой хэш (первый пуш ветки в
 * CI) — базы нет. Явно заданная, но не найденная база — ошибка: иначе неполная история
 * (клон без `fetch-depth: 0`) молча выключила бы проверку.
 */
function baseRef() {
  const env = process.env.KCHS_CONTRACTS_BASE?.trim()
  if (env && /^0+$/.test(env)) return null
  for (const ref of env ? [env] : ['origin/main', 'main']) {
    try {
      return git(['merge-base', 'HEAD', ref]).trim()
    } catch {
      // нет такой ссылки или общей истории — пробуем следующую
    }
  }
  if (env) {
    process.stderr.write(
      `KCHS_CONTRACTS_BASE=${env}: нет общей истории с HEAD — нужен полный клон (fetch-depth: 0)\n`,
    )
    process.exit(2)
  }
  return null
}

const readCurrent = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'))
function readBase(ref, path) {
  if (!ref) return null
  try {
    return JSON.parse(git(['show', `${ref}:${path}`]))
  } catch {
    return null
  }
}

// ─── Запуск ──────────────────────────────────────────────────────────────────

function loadAllowed() {
  let data = { events: {}, api: {} }
  try {
    data = JSON.parse(readFileSync(resolve(ROOT, ALLOWED), 'utf8'))
  } catch {
    // файла нет — исключений нет
  }
  const bad = [...Object.entries(data.events ?? {}), ...Object.entries(data.api ?? {})].filter(
    ([, reason]) => typeof reason !== 'string' || !/^ADR-\d{4}\b/.test(reason),
  )
  if (bad.length > 0) {
    process.stderr.write(
      `${ALLOWED}: у исключения нет ссылки на ADR («ADR-NNNN: причина»): ${bad.map(([k]) => k).join(', ')}\n`,
    )
    process.exit(1)
  }
  return { events: data.events ?? {}, api: data.api ?? {} }
}

const ref = baseRef()
const allowed = loadAllowed()
let failed = false
const print = (title, result) => {
  for (const note of result.notes) process.stdout.write(`  · ${note}\n`)
  for (const f of result.permitted) {
    process.stdout.write(
      `  ~ ${f.key}${f.path ? ` (${f.path})` : ''}: ${f.kind} — разрешено: ${f.reason}\n`,
    )
  }
  for (const f of result.errors) {
    process.stdout.write(
      `  ✗ ${f.key}${f.path ? ` (${f.path})` : ''}: ${f.kind}${f.detail ? ` — ${f.detail}` : ''}\n`,
    )
  }
  if (result.errors.length > 0) failed = true
  process.stdout.write(
    `${title}: ${result.errors.length === 0 ? 'совместимо' : `ломающих изменений ${result.errors.length}`}\n`,
  )
}

process.stdout.write(`Совместимость контрактов с ${ref ?? '(базы нет)'}\n`)
for (const [enabled, path, title, compare, list] of [
  [checkEvents, EVENTS, 'События', compareEvents, allowed.events],
  [checkApi, API, 'API', compareApi, allowed.api],
]) {
  if (!enabled) continue
  const base = readBase(ref, path)
  if (!base) {
    process.stdout.write(`${title}: в базе снимка нет — сравнивать не с чем\n`)
    continue
  }
  print(title, compare(base, readCurrent(path), list))
}
if (failed) {
  process.stdout.write(
    'Ломающее изменение события — повысьте его версию в EVENT_VERSIONS (packages/contracts/src/events/catalog.ts); ' +
      `API — новая операция вместо изменения или запись в ${ALLOWED} со ссылкой на ADR (ADR-0189).\n`,
  )
  process.exit(1)
}
