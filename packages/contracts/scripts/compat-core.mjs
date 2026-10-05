/**
 * Правила совместимости контрактов (ADR-0189) — чистые функции без git и файлов; оболочка
 * `contracts-compat.mjs` читает снимки и печатает итог, тесты — `__tests__/compat-core.test.ts`.
 */
import { resolveRef } from './snapshot-format.mjs'

// ─── Сравнение схем ──────────────────────────────────────────────────────────

/**
 * Сторона схемы: `writer` — данные шлёт клиент (тело и параметры запроса), `reader` — данные
 * получает клиент (ответ), `both` — нагрузка события: её пишет платформа, а читают подписчики и
 * внешние системы, поэтому для неё действуют правила обеих сторон.
 */
const isWriter = (side) => side === 'writer' || side === 'both'
const isReader = (side) => side === 'reader' || side === 'both'

/**
 * Тип за ссылкой вне снимка неизвестен: так было с висячими ссылками `schema0` прежней
 * спецификации (ADR-0188). Неизвестное — не «любое»: сравнивать нечего, как и саму ссылку.
 */
const UNKNOWN = Symbol('тип вне снимка')

/**
 * Множество типов JSON схемы; `null` — тип не ограничен; `UNKNOWN` — в объединении есть
 * ссылка вне снимка.
 */
function typesOf(schema, defs) {
  if (opaque(schema)) return UNKNOWN
  if (Array.isArray(schema.type)) return new Set(schema.type)
  if (typeof schema.type === 'string') return new Set([schema.type])
  const values = valuesOf(schema)
  if (values) return new Set(values.map((v) => (v === null ? 'null' : typeof v)))
  const variants = schema.anyOf ?? schema.oneOf ?? schema.allOf
  if (Array.isArray(variants)) {
    const all = new Set()
    let unknown = false
    for (const variant of variants) {
      const resolved = resolveRef(variant, defs)
      const types = resolved && typeof resolved === 'object' ? typesOf(resolved, defs) : null
      if (types === null) return null
      if (types === UNKNOWN) unknown = true
      else for (const t of types) all.add(t)
    }
    return unknown ? UNKNOWN : all
  }
  return null
}

/** Допустимые значения: перечисление или константа; `null` — значения не ограничены. */
function valuesOf(schema) {
  if (Array.isArray(schema.enum)) return schema.enum
  return 'const' in schema ? [schema.const] : null
}

/** Обёртка «или null» (`anyOf: [X, { type: 'null' }]`): структура сравнивается по X. */
function unwrapNullable(schema, defs) {
  const variants = schema.anyOf ?? schema.oneOf
  if (!Array.isArray(variants) || variants.length !== 2) return schema
  const resolved = variants.map((v) => resolveRef(v, defs))
  const i = resolved.findIndex((v) => v?.type === 'null' && Object.keys(v).length === 1)
  const inner = i === -1 ? null : resolved[1 - i]
  return inner && typeof inner === 'object' ? inner : schema
}

/**
 * Ограничения значения: ужесточение ломает пишущую сторону — прежние данные перестают
 * проходить. Ослабление допустимо: читающий не обязан знать прежние границы.
 */
const LOWER = ['minLength', 'minItems', 'minProperties', 'minimum', 'exclusiveMinimum']
const UPPER = ['maxLength', 'maxItems', 'maxProperties', 'maximum', 'exclusiveMaximum']

function tightened(a, b) {
  const found = []
  for (const key of LOWER) {
    if (typeof b[key] === 'number' && !(typeof a[key] === 'number' && b[key] <= a[key])) {
      found.push(`${key} ${a[key] ?? '—'} → ${b[key]}`)
    }
  }
  for (const key of UPPER) {
    if (typeof b[key] === 'number' && !(typeof a[key] === 'number' && b[key] >= a[key])) {
      found.push(`${key} ${a[key] ?? '—'} → ${b[key]}`)
    }
  }
  for (const key of ['pattern', 'multipleOf']) {
    if (b[key] !== undefined && a[key] !== b[key]) found.push(key)
  }
  return found
}

/** Типы базы (`ta`) и рабочего дерева (`tb`); `null` — тип не ограничен. */
function diffTypes(ta, tb, path, side, out) {
  if (ta && tb) {
    const added = [...tb].filter((t) => !ta.has(t) && !(t === 'integer' && ta.has('number')))
    const removed = [...ta].filter((t) => !tb.has(t) && !(t === 'integer' && tb.has('number')))
    if (isWriter(side) && removed.length > 0) {
      out.push({ path, kind: 'тип сузился', detail: `больше не принимает ${removed.join(', ')}` })
    }
    if (isReader(side) && added.length > 0) {
      out.push({ path, kind: 'тип расширился', detail: `теперь может быть ${added.join(', ')}` })
    }
  } else if (isWriter(side) && !ta && tb) {
    out.push({ path, kind: 'тип сузился', detail: `был любым, стал ${[...tb].join(', ')}` })
  } else if (isReader(side) && ta && !tb) {
    out.push({ path, kind: 'тип расширился', detail: 'теперь любой' })
  }
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
const opaque = (s) => typeof s.$ref === 'string' // ссылка вне снимка: сравнивать нечего

/** Сравнить схему базы (`a`) со схемой рабочего дерева (`b`); найденное — в `out`. */
export function diffSchema(a0, b0, ctx, path, side, out) {
  // Рекурсивная схема ссылается на себя (компонент `FilterNode`, ADR-0188): пара ссылок
  // сравнивается на пути один раз, иначе обход не кончится
  const pair =
    typeof a0?.$ref === 'string' && typeof b0?.$ref === 'string'
      ? `${side} ${a0.$ref} ${b0.$ref}`
      : null
  if (pair) {
    ctx.comparing ??= new Set()
    if (ctx.comparing.has(pair)) return
    ctx.comparing.add(pair)
  }
  try {
    diffResolved(a0, b0, ctx, path, side, out)
  } finally {
    if (pair) ctx.comparing.delete(pair)
  }
}

function diffResolved(a0, b0, ctx, path, side, out) {
  const wa = resolveRef(a0, ctx.baseDefs)
  const wb = resolveRef(b0, ctx.currentDefs)
  if (!wa || !wb || typeof wa !== 'object' || typeof wb !== 'object') return
  if (opaque(wa) || opaque(wb)) return

  // Типы — по обёртке целиком: «стало nullable» — расширение, «перестало» — сужение. Сторона
  // со ссылкой вне снимка типа не знает — сравнивать не с чем
  const ta = typesOf(wa, ctx.baseDefs)
  const tb = typesOf(wb, ctx.currentDefs)
  if (ta !== UNKNOWN && tb !== UNKNOWN) diffTypes(ta, tb, path, side, out)

  const a = unwrapNullable(wa, ctx.baseDefs)
  const b = unwrapNullable(wb, ctx.currentDefs)

  // Значения: убранное значение или новое ограничение списком отвергает прежние данные.
  // Новое значение допустимо — получатель обязан терпеть незнакомые значения, как и поля
  const va = valuesOf(a)
  const vb = valuesOf(b)
  if (isWriter(side) && vb) {
    const gone = va ? va.filter((v) => !vb.some((w) => same(v, w))) : null
    if (!va) {
      out.push({
        path,
        kind: 'значения ограничены',
        detail: vb.map((v) => JSON.stringify(v)).join(', '),
      })
    } else if (gone.length > 0) {
      out.push({
        path,
        kind: 'значения убраны',
        detail: gone.map((v) => JSON.stringify(v)).join(', '),
      })
    }
  }

  // Формат строки (uuid, email, date-time) — часть типа
  if (a.format !== b.format) {
    if (a.format && b.format) {
      out.push({ path, kind: 'формат сменился', detail: `${a.format} → ${b.format}` })
    } else if (b.format && isWriter(side)) {
      out.push({ path, kind: 'тип сузился', detail: `теперь только ${b.format}` })
    } else if (a.format && isReader(side)) {
      out.push({ path, kind: 'тип расширился', detail: `больше не обязательно ${a.format}` })
    }
  }
  if (isWriter(side)) {
    const limits = tightened(a, b)
    if (limits.length > 0) {
      out.push({ path, kind: 'ограничение ужесточилось', detail: limits.join(', ') })
    }
  }

  // Объект: поля и их обязательность
  if (a.properties && b.properties) {
    const ra = new Set(a.required ?? [])
    const rb = new Set(b.required ?? [])
    for (const name of Object.keys(a.properties)) {
      const field = path ? `${path}.${name}` : name
      if (!(name in b.properties)) {
        out.push({ path: field, kind: 'поле удалено', detail: '' })
        continue
      }
      if (isWriter(side) && !ra.has(name) && rb.has(name)) {
        out.push({ path: field, kind: 'поле стало обязательным', detail: '' })
      }
      if (isReader(side) && ra.has(name) && !rb.has(name)) {
        out.push({ path: field, kind: 'поле стало необязательным', detail: '' })
      }
      diffSchema(a.properties[name], b.properties[name], ctx, field, side, out)
    }
    if (isWriter(side)) {
      for (const name of Object.keys(b.properties)) {
        if (!(name in a.properties) && rb.has(name)) {
          out.push({
            path: path ? `${path}.${name}` : name,
            kind: 'новое обязательное поле',
            detail: '',
          })
        }
      }
    }
  }
  if (
    a.additionalProperties &&
    b.additionalProperties &&
    typeof a.additionalProperties === 'object' &&
    typeof b.additionalProperties === 'object'
  ) {
    diffSchema(a.additionalProperties, b.additionalProperties, ctx, `${path}{*}`, side, out)
  }
  if (a.items && b.items && !Array.isArray(a.items) && !Array.isArray(b.items)) {
    diffSchema(a.items, b.items, ctx, `${path}[]`, side, out)
  }

  // Варианты объединения: убранный вариант отвергает прежние данные; новый допустим, как
  // новое значение перечисления. Сопоставляются по порядку, если их число не изменилось
  const ua = a.anyOf ?? a.oneOf
  const ub = b.anyOf ?? b.oneOf
  if (Array.isArray(ua) && Array.isArray(ub)) {
    if (ua.length === ub.length) {
      for (const [i, variant] of ua.entries()) {
        diffSchema(variant, ub[i], ctx, `${path}|${i}`, side, out)
      }
    } else if (isWriter(side) && ub.length < ua.length) {
      out.push({ path, kind: 'вариант убран', detail: `вариантов ${ua.length} → ${ub.length}` })
    }
  }
}

// ─── События ─────────────────────────────────────────────────────────────────

export function compareEvents(base, current, allowed) {
  const findings = []
  const notes = []
  const ctx = { baseDefs: {}, currentDefs: {} }
  for (const type of Object.keys(base)) {
    const was = base[type]
    const now = current[type]
    if (!now) {
      findings.push({ key: type, path: '', kind: 'событие удалено', detail: '' })
      continue
    }
    if (now.version < was.version) {
      findings.push({
        key: type,
        path: '',
        kind: 'версия уменьшилась',
        detail: `${was.version} → ${now.version}`,
      })
      continue
    }
    if (now.version > was.version) {
      notes.push(`${type}: версия ${was.version} → ${now.version} — изменение нагрузки допускается`)
      continue
    }
    const out = []
    diffSchema(was.schema, now.schema, ctx, '', 'both', out)
    for (const f of out) findings.push({ key: type, ...f })
  }
  const added = Object.keys(current).filter((type) => !(type in base))
  if (added.length > 0) notes.push(`новые события: ${added.length}`)
  return split(findings, allowed, notes)
}

// ─── API ─────────────────────────────────────────────────────────────────────

export function compareApi(base, current, allowed) {
  const findings = []
  const notes = []
  const ctx = { baseDefs: base.defs ?? {}, currentDefs: current.defs ?? {} }
  for (const key of Object.keys(base.operations ?? {})) {
    const was = resolveRef(base.operations[key], ctx.baseDefs)
    const nowRaw = current.operations?.[key]
    if (!nowRaw) {
      findings.push({ key, path: '', kind: 'операция удалена', detail: '' })
      continue
    }
    const now = resolveRef(nowRaw, ctx.currentDefs)
    const out = []

    const params = (op) => new Map((op.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]))
    const pa = params(was)
    const pb = params(now)
    for (const [name, p] of pa) {
      const q = pb.get(name)
      if (!q) {
        out.push({ path: `параметр ${name}`, kind: 'параметр удалён', detail: '' })
        continue
      }
      if (!p.required && q.required)
        out.push({ path: `параметр ${name}`, kind: 'параметр стал обязательным', detail: '' })
      diffSchema(p.schema, q.schema, ctx, `параметр ${name}`, 'writer', out)
    }
    for (const [name, q] of pb) {
      if (!pa.has(name) && q.required)
        out.push({ path: `параметр ${name}`, kind: 'новый обязательный параметр', detail: '' })
    }

    if (was.body && !now.body) out.push({ path: 'тело', kind: 'тело запроса убрано', detail: '' })
    if (!was.body && now.body?.required)
      out.push({ path: 'тело', kind: 'новое обязательное тело', detail: '' })
    if (was.body && now.body) {
      if (!was.body.required && now.body.required)
        out.push({ path: 'тело', kind: 'тело стало обязательным', detail: '' })
      for (const type of Object.keys(was.body.content ?? {})) {
        if (!(type in (now.body.content ?? {}))) {
          out.push({ path: `тело ${type}`, kind: 'тип содержимого убран', detail: '' })
          continue
        }
        diffSchema(was.body.content[type], now.body.content[type], ctx, 'тело', 'writer', out)
      }
    }

    for (const status of Object.keys(was.responses ?? {})) {
      if (!/^2/.test(status)) continue
      if (!(status in (now.responses ?? {}))) {
        out.push({ path: `ответ ${status}`, kind: 'код ответа убран', detail: '' })
        continue
      }
      const ra = was.responses[status] ?? {}
      const rb = now.responses[status] ?? {}
      for (const type of Object.keys(ra)) {
        if (!(type in rb)) {
          out.push({ path: `ответ ${status} ${type}`, kind: 'тип содержимого убран', detail: '' })
          continue
        }
        diffSchema(ra[type], rb[type], ctx, `ответ ${status}`, 'reader', out)
      }
    }
    for (const f of out) findings.push({ key, ...f })
  }
  const added = Object.keys(current.operations ?? {}).filter(
    (key) => !(key in (base.operations ?? {})),
  )
  if (added.length > 0) notes.push(`новые операции: ${added.length}`)
  return split(findings, allowed, notes)
}

/**
 * Разделить найденное на разрешённое (запись со ссылкой на ADR) и ошибки. Исключение, которое
 * не понадобилось, — в заметки: его снимают, чтобы оно не пропустило следующую поломку.
 */
function split(findings, allowed, notes) {
  const errors = []
  const permitted = []
  for (const f of findings) {
    if (allowed[f.key]) permitted.push({ ...f, reason: allowed[f.key] })
    else errors.push(f)
  }
  const used = new Set(permitted.map((f) => f.key))
  const unused = Object.keys(allowed).filter((key) => !used.has(key))
  if (unused.length > 0) {
    notes.push(`исключения не понадобились — уберите их из списка: ${unused.join(', ')}`)
  }
  return { errors, permitted, notes }
}
