#!/usr/bin/env node
/**
 * Снимок OpenAPI (ADR-0189): из полной спецификации `openapi.json` (её собирает
 * `pnpm openapi:gen`, ~12 МБ, в git не хранится) — структура каждой операции: параметры,
 * тело, ответы. Схемы нормализованы, повторы вынесены в общие (`defs`), по строке на операцию
 * и на общую схему. Компоненты спецификации — тоже в `defs`, под своей ссылкой (ADR-0188). Снимок — `apps/api/openapi.snapshot.json` в git; проверка совместимости
 * (`pnpm contracts:compat`) сравнивает его с базовой веткой.
 *
 *   node scripts/snapshot-openapi.mjs           — перезаписать снимок
 *   node scripts/snapshot-openapi.mjs --check   — снимок не отстал от openapi.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { normalizeSchema, shareRepeats } from '@kchs/contracts/snapshot-format'

const SPEC = new URL('../openapi.json', import.meta.url)
const FILE = new URL('../openapi.snapshot.json', import.meta.url)
const METHODS = ['get', 'put', 'post', 'patch', 'delete']

let spec
try {
  spec = JSON.parse(readFileSync(SPEC, 'utf8'))
} catch {
  process.stderr.write('Нет apps/api/openapi.json: сначала `pnpm openapi:gen`\n')
  process.exit(2)
}

/** Схемы по типам содержимого: `{ "application/json": <схема> }`. */
function contentSchemas(content) {
  const out = {}
  for (const type of Object.keys(content ?? {}).sort()) {
    out[type] = normalizeSchema(content[type]?.schema ?? {})
  }
  return out
}

function operation(op) {
  const parameters = (op.parameters ?? [])
    .map((p) => ({
      in: p.in,
      name: p.name,
      required: Boolean(p.required),
      schema: normalizeSchema(p.schema ?? {}),
    }))
    .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`))
  const body = op.requestBody
    ? {
        required: Boolean(op.requestBody.required),
        content: contentSchemas(op.requestBody.content),
      }
    : null
  const responses = {}
  for (const status of Object.keys(op.responses ?? {}).sort()) {
    const response = op.responses[status]
    responses[status] = response?.content ? contentSchemas(response.content) : null
  }
  return { parameters, body, responses }
}

const operations = {}
for (const path of Object.keys(spec.paths ?? {})) {
  for (const method of METHODS) {
    const op = spec.paths[path]?.[method]
    if (op) operations[`${method.toUpperCase()} ${path}`] = operation(op)
  }
}

const { records, defs } = shareRepeats(operations)
// Именованные компоненты — рекурсивные схемы (ADR-0188): под ключом-ссылкой, которой их
// называют операции, — сравнение снимков заходит внутрь них
for (const name of Object.keys(spec.components?.schemas ?? {}).sort()) {
  defs[`#/components/schemas/${name}`] = normalizeSchema(spec.components.schemas[name])
}
const lines = (record) =>
  Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${JSON.stringify(record[key])}`)
    .join(',\n')
const text = `{\n"operations": {\n${lines(records)}\n},\n"defs": {\n${lines(defs)}\n}\n}\n`

if (process.argv.includes('--check')) {
  let committed = ''
  try {
    committed = readFileSync(FILE, 'utf8')
  } catch {
    // снимка ещё нет
  }
  if (committed !== text) {
    process.stderr.write(
      'Снимок OpenAPI отстал от маршрутов: выполните `pnpm contracts:snapshot` и закоммитьте ' +
        'apps/api/openapi.snapshot.json (ADR-0189)\n',
    )
    process.exit(1)
  }
  process.stdout.write(`Снимок OpenAPI актуален: ${Object.keys(records).length} операций\n`)
} else {
  writeFileSync(FILE, text, 'utf8')
  process.stdout.write(
    `Снимок OpenAPI записан: ${Object.keys(records).length} операций, ${Object.keys(defs).length} общих схем\n`,
  )
}
