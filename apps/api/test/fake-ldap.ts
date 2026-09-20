import type { AddressInfo } from 'node:net'
import { createServer, type Server, type Socket } from 'node:net'

/**
 * Поддельный сервер LDAP для интеграционных тестов: настоящий протокол по TCP,
 * клиент (`ldapts`) работает с ним как с каталогом. Внешние службы для тестов
 * не нужны — так же, как поддельная служба доставки push в `push.test.ts`.
 *
 * Поддержано ровно то, чем пользуется платформа: простая привязка (bind),
 * поиск с фильтрами `and`/`or`/`not`/`=`/`present` и отсоединение. Постраничное
 * чтение сервер вправе не применять — он отдаёт всё одной страницей без
 * управляющего элемента, и клиент на этом останавливается.
 */

export interface FakeEntry {
  dn: string
  attributes: Record<string, string[]>
}

export interface FakeLdapOptions {
  entries: FakeEntry[]
  /** DN → пароль: чем может привязаться учётная запись. */
  passwords: Record<string, string>
}

// ─── Кодирование BER ─────────────────────────────────────────────────────────

function berLength(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  let rest = size
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest = Math.floor(rest / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), berLength(value.length), value])
}

function berInteger(tag: number, value: number): Buffer {
  const bytes: number[] = []
  let rest = value
  do {
    bytes.unshift(rest & 0xff)
    rest = rest >> 8
  } while (rest > 0)
  if (((bytes[0] as number) & 0x80) !== 0) bytes.unshift(0)
  return tlv(tag, Buffer.from(bytes))
}

const octet = (value: string) => tlv(0x04, Buffer.from(value, 'utf8'))
const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts))
const setOf = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts))

/** LDAPResult: код результата, matchedDN и диагностика. */
function result(tag: number, code: number, message = ''): Buffer {
  return tlv(tag, Buffer.concat([berInteger(0x0a, code), octet(''), octet(message)]))
}

function message(id: number, protocolOp: Buffer): Buffer {
  return sequence(berInteger(0x02, id), protocolOp)
}

// ─── Разбор BER ──────────────────────────────────────────────────────────────

interface Tlv {
  tag: number
  value: Buffer
  end: number
}

function readTlv(buffer: Buffer, offset: number): Tlv | null {
  if (offset + 2 > buffer.length) return null
  const tag = buffer[offset] as number
  const first = buffer[offset + 1] as number
  let size = first
  let cursor = offset + 2
  if (first & 0x80) {
    const count = first & 0x7f
    if (offset + 2 + count > buffer.length) return null
    size = 0
    for (let i = 0; i < count; i++) size = size * 256 + (buffer[offset + 2 + i] as number)
    cursor = offset + 2 + count
  }
  if (cursor + size > buffer.length) return null
  return { tag, value: buffer.subarray(cursor, cursor + size), end: cursor + size }
}

function readInteger(value: Buffer): number {
  let result = 0
  for (const byte of value) result = result * 256 + byte
  return result
}

// ─── Фильтры поиска ──────────────────────────────────────────────────────────

type Filter =
  | { kind: 'and' | 'or'; parts: Filter[] }
  | { kind: 'not'; part: Filter }
  | { kind: 'equal'; attribute: string; value: string }
  | { kind: 'present'; attribute: string }
  | { kind: 'any' }

function parseFilter(tlvValue: Tlv): Filter {
  switch (tlvValue.tag) {
    case 0xa0:
    case 0xa1: {
      const parts: Filter[] = []
      let offset = 0
      for (;;) {
        const part = readTlv(tlvValue.value, offset)
        if (!part) break
        parts.push(parseFilter(part))
        offset = part.end
      }
      return { kind: tlvValue.tag === 0xa0 ? 'and' : 'or', parts }
    }
    case 0xa2: {
      const inner = readTlv(tlvValue.value, 0)
      return inner ? { kind: 'not', part: parseFilter(inner) } : { kind: 'any' }
    }
    case 0xa3: {
      const attribute = readTlv(tlvValue.value, 0)
      const value = attribute ? readTlv(tlvValue.value, attribute.end) : null
      if (!attribute || !value) return { kind: 'any' }
      return {
        kind: 'equal',
        attribute: attribute.value.toString('utf8').toLowerCase(),
        value: value.value.toString('utf8'),
      }
    }
    case 0x87:
      return { kind: 'present', attribute: tlvValue.value.toString('utf8').toLowerCase() }
    default:
      // Подстроки и прочие виды тестам не нужны: считаем совпадением
      return { kind: 'any' }
  }
}

/** Каталоги не различают регистр имён атрибутов. */
function valuesOf(entry: FakeEntry, attribute: string): string[] {
  const needle = attribute.toLowerCase()
  for (const [name, values] of Object.entries(entry.attributes)) {
    if (name.toLowerCase() === needle) return values
  }
  return []
}

function matches(entry: FakeEntry, filter: Filter): boolean {
  switch (filter.kind) {
    case 'and':
      return filter.parts.every((part) => matches(entry, part))
    case 'or':
      return filter.parts.some((part) => matches(entry, part))
    case 'not':
      return !matches(entry, filter.part)
    case 'present':
      return valuesOf(entry, filter.attribute).length > 0
    case 'equal':
      return valuesOf(entry, filter.attribute).some(
        (value) => value.toLowerCase() === filter.value.toLowerCase(),
      )
    default:
      return true
  }
}

function inScope(entry: FakeEntry, baseDn: string): boolean {
  const base = baseDn.toLowerCase().trim()
  if (!base) return true
  const dn = entry.dn.toLowerCase()
  return dn === base || dn.endsWith(`,${base}`)
}

// ─── Сервер ──────────────────────────────────────────────────────────────────

export interface FakeLdap {
  url: string
  close: () => Promise<void>
  /** Запросы привязки: по ним тест проверяет, чем именно проверялся пароль. */
  binds: Array<{ dn: string; ok: boolean }>
  set: (options: FakeLdapOptions) => void
}

export async function startFakeLdap(options: FakeLdapOptions): Promise<FakeLdap> {
  let state = options
  const binds: Array<{ dn: string; ok: boolean }> = []

  const server: Server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const envelope = readTlv(buffer, 0)
        if (!envelope) break
        buffer = buffer.subarray(envelope.end)
        handle(socket, envelope.value, state, binds)
      }
    })
    socket.on('error', () => socket.destroy())
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `ldap://127.0.0.1:${port}`,
    binds,
    set: (next) => {
      state = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function handle(
  socket: Socket,
  envelope: Buffer,
  state: FakeLdapOptions,
  binds: Array<{ dn: string; ok: boolean }>,
): void {
  const idTlv = readTlv(envelope, 0)
  if (!idTlv) return
  const id = readInteger(idTlv.value)
  const op = readTlv(envelope, idTlv.end)
  if (!op) return

  // BindRequest: версия, DN, [0] простой пароль
  if (op.tag === 0x60) {
    const version = readTlv(op.value, 0)
    const name = version ? readTlv(op.value, version.end) : null
    const password = name ? readTlv(op.value, name.end) : null
    const dn = name ? name.value.toString('utf8') : ''
    const secret = password ? password.value.toString('utf8') : ''
    // Пустой DN — анонимная привязка, каталог её принимает
    const ok =
      dn === '' ? true : state.passwords[dn] !== undefined && state.passwords[dn] === secret
    binds.push({ dn, ok })
    // 49 — invalidCredentials
    socket.write(message(id, result(0x61, ok ? 0 : 49, ok ? '' : 'invalid credentials')))
    return
  }

  // UnbindRequest — соединение закрывает клиент
  if (op.tag === 0x42) {
    socket.end()
    return
  }

  // SearchRequest: база, область, deref, лимиты, typesOnly, фильтр, атрибуты
  if (op.tag === 0x63) {
    const base = readTlv(op.value, 0)
    if (!base) return
    const scope = readTlv(op.value, base.end)
    const deref = scope ? readTlv(op.value, scope.end) : null
    const sizeLimit = deref ? readTlv(op.value, deref.end) : null
    const timeLimit = sizeLimit ? readTlv(op.value, sizeLimit.end) : null
    const typesOnly = timeLimit ? readTlv(op.value, timeLimit.end) : null
    const filterTlv = typesOnly ? readTlv(op.value, typesOnly.end) : null
    const attributesTlv = filterTlv ? readTlv(op.value, filterTlv.end) : null

    const baseDn = base.value.toString('utf8')
    const filter: Filter = filterTlv ? parseFilter(filterTlv) : { kind: 'any' }
    const requested = new Set<string>()
    if (attributesTlv) {
      let offset = 0
      for (;;) {
        const item = readTlv(attributesTlv.value, offset)
        if (!item) break
        requested.add(item.value.toString('utf8').toLowerCase())
        offset = item.end
      }
    }

    for (const entry of state.entries) {
      if (!inScope(entry, baseDn) || !matches(entry, filter)) continue
      const attributes: Buffer[] = []
      for (const [name, values] of Object.entries(entry.attributes)) {
        if (requested.size > 0 && !requested.has(name.toLowerCase())) continue
        attributes.push(sequence(octet(name), setOf(...values.map(octet))))
      }
      socket.write(
        message(id, tlv(0x64, Buffer.concat([octet(entry.dn), sequence(...attributes)]))),
      )
    }
    socket.write(message(id, result(0x65, 0)))
    return
  }

  // Прочие операции тестам не нужны: отвечаем «не поддержано» (53)
  socket.write(message(id, result(0x65, 53, 'unsupported')))
}
