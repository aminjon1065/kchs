#!/usr/bin/env node
/**
 * Кольца между модулями (ADR-0181). Правило `no-circular` dependency-cruiser ищет
 * циклы между файлами, а модули замыкаются и через разные файлы (так было кольцо
 * calendar → meetings → documents → calendar). Скрипт сворачивает граф импортов до
 * модулей `src/modules/<имя>` и ищет компоненты сильной связности (алгоритм Тарьяна):
 * компонента больше одного модуля — ошибка.
 *
 *   node scripts/module-cycles.mjs            проверка (часть `pnpm deps:check`)
 *   node scripts/module-cycles.mjs --layers   ещё и слои: L0 — модули без зависимостей
 *                                             от других модулей, Ln — над L(n-1)
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Временные исключения: рёбра, которые снимет названная часть этапа. Исключение,
 * ребра которого больше нет, — тоже ошибка: список не должен устаревать.
 */
const ALLOWED_EDGES = [
  // { from: 'модуль', to: 'модуль', until: 'ADR-NNNN' } — ребро, которое снимет часть этапа
]

const moduleOf = (file) => /^src\/modules\/([^/]+)\//.exec(file ?? '')?.[1] ?? null

function cruise() {
  const run = spawnSync(
    path.join(ROOT, 'node_modules/.bin/depcruise'),
    ['--config', '.dependency-cruiser.cjs', '--output-type', 'json', 'src'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  )
  // Код выхода ненулевой и при известных нарушениях правил — граф всё равно в выводе
  if (!run.stdout) {
    process.stderr.write(run.stderr || 'dependency-cruiser не вернул граф\n')
    process.exit(2)
  }
  return JSON.parse(run.stdout)
}

/** Рёбра модуль → модуль с примерами файлов, по которым они идут. */
function moduleGraph(result) {
  const edges = new Map()
  const modules = new Set()
  for (const file of result.modules) {
    const from = moduleOf(file.source)
    if (!from) continue
    modules.add(from)
    for (const dependency of file.dependencies ?? []) {
      const to = moduleOf(dependency.resolved)
      if (!to || to === from) continue
      modules.add(to)
      const targets = edges.get(from) ?? new Map()
      const via = targets.get(to) ?? []
      if (via.length < 3) via.push(`${file.source} → ${dependency.resolved}`)
      targets.set(to, via)
      edges.set(from, targets)
    }
  }
  return { modules: [...modules].sort(), edges }
}

/** Компоненты сильной связности (Тарьян). */
function components(nodes, next) {
  let index = 0
  const indexOf = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const found = []
  const visit = (node) => {
    indexOf.set(node, index)
    low.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const target of next(node)) {
      if (!indexOf.has(target)) {
        visit(target)
        low.set(node, Math.min(low.get(node), low.get(target)))
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node), indexOf.get(target)))
      }
    }
    if (low.get(node) === indexOf.get(node)) {
      const component = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        component.push(member)
      } while (member !== node)
      found.push(component.sort())
    }
  }
  for (const node of nodes) if (!indexOf.has(node)) visit(node)
  return found
}

/** Слой модуля — длина самого длинного пути вниз по зависимостям (граф без колец). */
function layers(nodes, next) {
  const level = new Map()
  const depth = (node) => {
    if (level.has(node)) return level.get(node)
    let best = 0
    for (const target of next(node)) best = Math.max(best, depth(target) + 1)
    level.set(node, best)
    return best
  }
  for (const node of nodes) depth(node)
  const byLevel = []
  for (const [node, value] of level) {
    if (!byLevel[value]) byLevel[value] = []
    byLevel[value].push(node)
  }
  return byLevel.map((members) => members.sort())
}

const { modules, edges } = moduleGraph(cruise())
const allowed = new Set(ALLOWED_EDGES.map((edge) => `${edge.from}→${edge.to}`))
const next = (node) =>
  [...(edges.get(node)?.keys() ?? [])].filter((target) => !allowed.has(`${node}→${target}`))

const problems = []
for (const edge of ALLOWED_EDGES) {
  if (!edges.get(edge.from)?.has(edge.to)) {
    problems.push(
      `исключение ${edge.from} → ${edge.to} (${edge.until}) больше не нужно — уберите его`,
    )
  }
}
for (const component of components(modules, next)) {
  if (component.length < 2) continue
  const inside = []
  for (const from of component) {
    for (const [to, via] of edges.get(from) ?? []) {
      if (component.includes(to) && !allowed.has(`${from}→${to}`)) {
        inside.push(`    ${from} → ${to}: ${via[0]}`)
      }
    }
  }
  problems.push(`кольцо модулей: ${component.join(', ')}\n${inside.join('\n')}`)
}

if (process.argv.includes('--layers')) {
  layers(modules, next).forEach((members, level) => {
    process.stdout.write(`L${level}: ${members.join(', ')}\n`)
  })
}

if (problems.length > 0) {
  process.stderr.write(`Кольца между модулями (ADR-0181):\n${problems.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(
  `✔ колец между модулями нет (${modules.length} модулей` +
    (ALLOWED_EDGES.length > 0 ? `, временных исключений: ${ALLOWED_EDGES.length}` : '') +
    ')\n',
)
