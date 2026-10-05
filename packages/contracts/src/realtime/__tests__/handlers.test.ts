import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { RT_CLIENT_EVENTS, RT_SERVER_EVENTS } from '../protocol.js'

/**
 * У каждого события realtime есть обработчик (ADR-0192). Тест обходит исходники api и web
 * компилятором TypeScript и собирает имена событий из вызовов:
 *  - сервер шлёт — `emitToRoom`, `emitToUser` (весь api) и `.emit` шлюза (`kernel/realtime`);
 *  - клиент слушает — `socket.on` клиента (`shared/realtime`) и `onRealtimeEvent` (весь web);
 *  - клиент шлёт — `socket.emit` клиента; шлюз слушает — `socket.on` шлюза.
 * Событие вне протокола, событие, которое шлют, но не слушают, и наоборот, роняют тест.
 * Сокет есть только у шлюза и у клиента realtime, поэтому `.emit` и `.on` в других местах —
 * не сообщения шлюза (события карты, редактора, потоков).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const API = path.join(ROOT, 'apps/api/src')
const WEB = path.join(ROOT, 'apps/web/src')
const GATEWAY = 'kernel/realtime'
const CLIENT = 'shared/realtime'

/** События транспорта Socket.IO: их шлёт и слушает сам Socket.IO, в протокол они не входят. */
const SOCKET_IO_RESERVED = new Set(['connect', 'connect_error', 'disconnect', 'disconnecting'])

/**
 * Вызовы, где имя события — не строка. Тест их не видит, поэтому каждое место — с причиной;
 * исключение, которое больше не встречается, тоже роняет тест.
 */
const DYNAMIC_NAMES: Array<{ file: string; callee: string; arg: string; reason: string }> = [
  {
    file: 'kernel/realtime/gateway.ts',
    callee: 'emitToRoom',
    arg: 'event',
    reason: '`emitToUser` — обёртка над `emitToRoom`: имя — параметр с типом события протокола',
  },
  {
    file: 'kernel/realtime/gateway.ts',
    callee: 'target.emit',
    arg: 'event',
    reason:
      '`emitVia` — общая отправка `emitToRoom` и ретрансляции: пару имя–нагрузка проверили ' +
      'тип `emitToRoom` и схема команды канала',
  },
]

interface Site {
  file: string
  line: number
  callee: string
  arg: string
  /** Имена событий; `null` — имя вычисляется. */
  names: string[] | null
}

/** Аргумент вызова с именем события — его номер; `null` — вызов не тот. */
type Matcher = (call: ts.CallExpression) => number | null

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full)
    return /\.tsx?$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name) ? [full] : []
  })
}

function namesOf(node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return namesOf(node.expression)
  if (ts.isConditionalExpression(node)) {
    const whenTrue = namesOf(node.whenTrue)
    const whenFalse = namesOf(node.whenFalse)
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null
  }
  return null
}

/** Корень цепочки: у `socket?.to(room).emit` — `socket`. */
function rootOf(node: ts.Expression): string | null {
  let current = node
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isCallExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : null
}

const fn =
  (name: string, arg: number): Matcher =>
  (call) =>
    ts.isIdentifier(call.expression) && call.expression.text === name ? arg : null

/** Метод `name` с именем события первым аргументом; `root` — у какого корня цепочки. */
const method =
  (name: string, root?: string): Matcher =>
  (call) => {
    const callee = call.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== name) return null
    return root === undefined || rootOf(callee.expression) === root ? 0 : null
  }

function scan(base: string, dir: string, matchers: Matcher[]): Site[] {
  const sites: Site[] = []
  for (const file of sources(path.join(base, dir))) {
    const text = readFileSync(file, 'utf8')
    if (!/emitTo(Room|User)\(|\.emit\(|\.on\(|onRealtimeEvent\(/.test(text)) continue
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        for (const matcher of matchers) {
          const index = matcher(node)
          const arg = index === null ? undefined : node.arguments[index]
          if (!arg) continue
          sites.push({
            file: path.relative(base, file),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            callee: node.expression.getText(source),
            arg: arg.getText(source),
            names: namesOf(arg),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

const serverSends = [
  ...scan(API, '', [fn('emitToRoom', 1), fn('emitToUser', 1)]),
  ...scan(API, GATEWAY, [method('emit')]),
]
const gatewayListens = scan(API, GATEWAY, [method('on', 'socket')])
const clientListens = [
  ...scan(WEB, '', [fn('onRealtimeEvent', 0)]),
  ...scan(WEB, CLIENT, [method('on', 'socket')]),
]
const clientSends = scan(WEB, CLIENT, [method('emit', 'socket')])

/** Имя → где встречается; события транспорта Socket.IO не считаются. */
function byName(sites: Site[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const site of sites) {
    for (const name of site.names ?? []) {
      if (SOCKET_IO_RESERVED.has(name)) continue
      result.set(name, [...(result.get(name) ?? []), `${site.file}:${site.line}`])
    }
  }
  return result
}

/** Расхождения отправок и подписок одного направления с протоколом. */
function mismatches(
  protocol: readonly string[],
  sent: Map<string, string[]>,
  heard: Map<string, string[]>,
): string[] {
  const known = new Set(protocol)
  const problems: string[] = []
  for (const [name, places] of sent) {
    if (!known.has(name)) problems.push(`шлют вне протокола: ${name} (${places.join(', ')})`)
    else if (!heard.has(name)) problems.push(`шлют, но не слушают: ${name} (${places.join(', ')})`)
  }
  for (const [name, places] of heard) {
    if (!known.has(name)) problems.push(`слушают вне протокола: ${name} (${places.join(', ')})`)
    else if (!sent.has(name)) problems.push(`слушают, но не шлют: ${name} (${places.join(', ')})`)
  }
  for (const name of protocol) {
    if (!sent.has(name) && !heard.has(name))
      problems.push(`в протоколе, но не шлют и не слушают: ${name}`)
  }
  return problems
}

describe('протокол realtime: у каждого события есть обработчик', () => {
  it('обход находит отправки и подписки обеих сторон', () => {
    // Защита от пустого обхода: сменился путь — тест не должен молча пройти
    expect(serverSends.length).toBeGreaterThan(30)
    expect(clientListens.length).toBeGreaterThan(15)
    expect(gatewayListens.length).toBeGreaterThanOrEqual(RT_CLIENT_EVENTS.length)
    expect(clientSends.length).toBeGreaterThanOrEqual(RT_CLIENT_EVENTS.length)
    // События транспорта обход пропускает — в протоколе их быть не должно
    const protocol = [...RT_SERVER_EVENTS, ...RT_CLIENT_EVENTS]
    expect(protocol.filter((name) => SOCKET_IO_RESERVED.has(name))).toEqual([])
  })

  it('сервер → клиент: каждое событие сервер шлёт, а клиент слушает', () => {
    expect(mismatches(RT_SERVER_EVENTS, byName(serverSends), byName(clientListens))).toEqual([])
  })

  it('клиент → сервер: каждое событие клиент шлёт, а шлюз слушает', () => {
    expect(mismatches(RT_CLIENT_EVENTS, byName(clientSends), byName(gatewayListens))).toEqual([])
  })

  it('имя события в вызове — строкой; вычисляемое — только из списка исключений', () => {
    const dynamic = [...serverSends, ...gatewayListens, ...clientListens, ...clientSends].filter(
      (site) => site.names === null,
    )
    const same = (item: (typeof DYNAMIC_NAMES)[number], site: Site) =>
      item.file === site.file && item.callee === site.callee && item.arg === site.arg
    const unexpected = dynamic.filter((site) => !DYNAMIC_NAMES.some((item) => same(item, site)))
    expect(
      unexpected.map((site) => `${site.file}:${site.line} ${site.callee}(${site.arg})`),
    ).toEqual([])
    const stale = DYNAMIC_NAMES.filter((item) => !dynamic.some((site) => same(item, site)))
    expect(stale.map((item) => `${item.file} ${item.callee}(${item.arg})`)).toEqual([])
  })
})
