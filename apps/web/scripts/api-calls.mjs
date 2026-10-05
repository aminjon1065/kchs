#!/usr/bin/env node
/**
 * Вызовы API web — по таблице маршрутов (ADR-0188). Путь, параметры, строку запроса,
 * тело и ответ клиента (`shared/api/client.ts`) выводит компилятор из таблицы; проверка
 * закрывает обходы, которые компилятор пропускает:
 *
 *  - явный параметр типа у вызова: `http.get<T>(…)`, `downloadFile<…>`, `apiUrl<…>`;
 *  - приведение типа в пути (`path as …`, кроме шаблона `as const`) и путь типа `any`;
 *  - строка запроса, тело или параметры типа `any` или с индексной сигнатурой
 *    (`Record<string, …>`): такой объект компилятор со схемой не сверяет;
 *  - адрес `/api/v1` строкой вне `shared/api/` и тестов без пометки
 *    `// вне клиента API: причина` на той же или предыдущей строке (шаблон тайлов MapLibre).
 *
 *   node scripts/api-calls.mjs     проверка (часть `pnpm deps:check`)
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(WEB, 'src')
const API_DIR = path.join(SRC, 'shared/api')
const MARKER = 'вне клиента API:'
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
const FIELDS = new Set(['params', 'query', 'body'])

const config = ts.readConfigFile(path.join(WEB, 'tsconfig.json'), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, WEB)
const program = ts.createProgram(
  parsed.fileNames.filter((file) => file.startsWith(SRC)),
  parsed.options,
)
const checker = program.getTypeChecker()

const violations = []
let calls = 0
let marked = 0

const rel = (file) => path.relative(WEB, file).split(path.sep).join('/')

/** Объявление идентификатора — в модуле клиента API (`client.ts`, `url.ts`)? */
function fromApiModule(node) {
  let symbol = checker.getSymbolAtLocation(node)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  const file = symbol?.declarations?.[0]?.getSourceFile().fileName
  return Boolean(file?.startsWith(API_DIR))
}

/** Вызов клиента: `http.<метод>`, `downloadFile`, `apiUrl` — и его имя для сообщения. */
function clientCall(node) {
  const callee = node.expression
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'http' &&
    METHODS.has(callee.name.text) &&
    fromApiModule(callee.expression)
  ) {
    return `http.${callee.name.text}`
  }
  if (
    ts.isIdentifier(callee) &&
    (callee.text === 'downloadFile' || callee.text === 'apiUrl') &&
    fromApiModule(callee)
  ) {
    return callee.text
  }
  return null
}

const isAny = (type) => (type.flags & ts.TypeFlags.Any) !== 0
const indexed = (type) =>
  Boolean(type.getStringIndexType()) ||
  (type.isUnion() && type.types.some((member) => Boolean(member.getStringIndexType())))

function report(sf, node, message) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  violations.push(`${rel(sf.fileName)}:${line + 1}  ${message}`)
}

/** Приведения типа в выражении пути; `as const` — шаблон, который сверяет компилятор. */
function castsIn(expr, found = []) {
  const isConst = (type) =>
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'const'
  if ((ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) && !isConst(expr.type)) {
    found.push(expr)
  }
  ts.forEachChild(expr, (child) => castsIn(child, found))
  return found
}

/** Значение поля опций: не `any`, без индексной сигнатуры, если её не ждёт схема. */
function checkValue(sf, name, label, expr) {
  const type = checker.getTypeAtLocation(expr)
  const expected = checker.getContextualType(expr)
  if (isAny(type)) report(sf, expr, `${name}: ${label} типа any — схема маршрута не проверяется`)
  else if (indexed(type) && !(expected && indexed(expected))) {
    report(
      sf,
      expr,
      `${name}: ${label} — ${checker.typeToString(type).slice(0, 80)}: объект с индексной сигнатурой схема не проверяет`,
    )
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop)) {
        checkValue(sf, name, `${label}.${prop.name.getText(sf)}`, prop.initializer)
      }
    }
  }
}

function checkCall(sf, node, name) {
  calls++
  if (node.typeArguments?.length) {
    report(sf, node, `${name}<…>: явный параметр типа — путь и ответ выводятся из таблицы`)
  }
  const [pathArg, options] = node.arguments
  if (pathArg) {
    for (const cast of castsIn(pathArg)) {
      report(sf, cast, `${name}: приведение типа в пути — путь берётся из таблицы маршрутов`)
    }
    if (isAny(checker.getTypeAtLocation(pathArg))) {
      report(sf, pathArg, `${name}: путь типа any — путь берётся из таблицы маршрутов`)
    }
  }
  if (!options) return
  if (!ts.isObjectLiteralExpression(options)) {
    if (isAny(checker.getTypeAtLocation(options))) report(sf, options, `${name}: опции типа any`)
    return
  }
  for (const prop of options.properties) {
    if (ts.isPropertyAssignment(prop) && FIELDS.has(prop.name.getText(sf))) {
      checkValue(sf, name, prop.name.getText(sf), prop.initializer)
    } else if (ts.isShorthandPropertyAssignment(prop) && FIELDS.has(prop.name.text)) {
      checkValue(sf, name, prop.name.text, prop.name)
    } else if (ts.isSpreadAssignment(prop)) {
      const type = checker.getTypeAtLocation(prop.expression)
      if (isAny(type) || indexed(type)) {
        report(
          sf,
          prop,
          `${name}: в опции разворачивается объект без схемы (${checker.typeToString(type).slice(0, 60)})`,
        )
      }
    }
  }
}

/** Сырой адрес API строкой: вне `shared/api/` — только с пометкой. */
function checkLiteral(sf, node, lines) {
  const text = ts.isTemplateExpression(node)
    ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('')
    : node.text
  if (!text.includes('/api/v1')) return
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  if (lines[line]?.includes(MARKER) || lines[line - 1]?.includes(MARKER)) {
    marked++
    return
  }
  report(sf, node, `адрес /api/v1 строкой — клиент http, apiUrl или пометка «// ${MARKER} причина»`)
}

for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.startsWith(SRC)) continue
  // Адреса в клиенте API и в данных тестов — не обращения к API
  const rawAllowed = sf.fileName.startsWith(API_DIR) || /\.test\.tsx?$/.test(sf.fileName)
  const lines = sf.text.split('\n')
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = clientCall(node)
      if (name) checkCall(sf, node, name)
    }
    if (
      !rawAllowed &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node))
    ) {
      checkLiteral(sf, node, lines)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (violations.length > 0) {
  process.stderr.write(
    `Вызовы API в обход таблицы маршрутов (ADR-0188):\n  ${violations.join('\n  ')}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  `✔ вызовы API по таблице маршрутов (${calls} вызовов; адресов вне клиента с пометкой: ${marked})\n`,
)
