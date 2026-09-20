import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'

/**
 * Поддельный ключ входа (WebAuthn) для интеграционных тестов: настоящая пара
 * P-256, настоящие CBOR-структуры и настоящая подпись ECDSA — проверяет их
 * библиотека `@simplewebauthn/server`, как и ключ настоящего устройства.
 */

const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_BACKUP_ELIGIBLE = 0x08
const FLAG_BACKED_UP = 0x10
const FLAG_ATTESTED_DATA = 0x40

// ─── Минимальный кодировщик CBOR ─────────────────────────────────────────────

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value])
  if (value < 0x10000) {
    const buffer = Buffer.alloc(3)
    buffer[0] = (major << 5) | 25
    buffer.writeUInt16BE(value, 1)
    return buffer
  }
  const buffer = Buffer.alloc(5)
  buffer[0] = (major << 5) | 26
  buffer.writeUInt32BE(value, 1)
  return buffer
}

interface CborMap extends Map<CborValue, CborValue> {}
interface CborRecord {
  [key: string]: CborValue
}
type CborValue = number | string | Buffer | CborMap | CborRecord

function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1)
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, bytes.length), bytes])
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([cborHead(2, value.length), value])
  }
  const entries: Array<[CborValue, CborValue]> =
    value instanceof Map ? [...value.entries()] : Object.entries(value)
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.map(([key, item]) => Buffer.concat([cbor(key), cbor(item)])),
  ])
}

// ─── Ключ ────────────────────────────────────────────────────────────────────

export interface FakeAuthenticatorOptions {
  /** Ключ подтверждает личность (PIN, отпечаток). */
  userVerified?: boolean
  /** Облачный passkey: синхронизируется между устройствами. */
  backedUp?: boolean
}

export interface WebAuthnResponse {
  id: string
  rawId: string
  type: 'public-key'
  clientExtensionResults: Record<string, unknown>
  response: Record<string, unknown>
}

export class FakeAuthenticator {
  readonly credentialId: Buffer
  private readonly privateKey: KeyObject
  private readonly coseKey: Buffer
  private counter = 0
  private readonly userVerified: boolean
  private readonly backedUp: boolean

  constructor(options: FakeAuthenticatorOptions = {}) {
    this.userVerified = options.userVerified ?? true
    this.backedUp = options.backedUp ?? false
    this.credentialId = randomBytes(32)
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = pair.privateKey
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    // COSE_Key для ES256: kty EC2, alg -7, crv P-256, координаты x и y
    this.coseKey = cbor(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    )
  }

  get id(): string {
    return this.credentialId.toString('base64url')
  }

  /** Ответ на `navigator.credentials.create()`. */
  register(challenge: string, origin: string, rpId: string): WebAuthnResponse {
    const clientDataJSON = clientData('webauthn.create', challenge, origin)
    const authData = this.authenticatorData(rpId, true)
    const attestationObject = cbor({
      fmt: 'none',
      attStmt: new Map<CborValue, CborValue>(),
      authData,
    })
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        // Браузер сообщает способы связи с ключом
        transports: ['internal'],
      },
    }
  }

  /** Ответ на `navigator.credentials.get()`. */
  authenticate(
    challenge: string,
    origin: string,
    rpId: string,
    userHandle?: string,
  ): WebAuthnResponse {
    this.counter += 1
    const clientDataJSON = clientData('webauthn.get', challenge, origin)
    const authData = this.authenticatorData(rpId, false)
    const digest = createHash('sha256').update(clientDataJSON).digest()
    const signature = sign('sha256', Buffer.concat([authData, digest]), this.privateKey)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        ...(userHandle
          ? { userHandle: Buffer.from(userHandle, 'utf8').toString('base64url') }
          : {}),
      },
    }
  }

  private authenticatorData(rpId: string, attested: boolean): Buffer {
    const rpIdHash = createHash('sha256').update(rpId, 'utf8').digest()
    let flags = FLAG_USER_PRESENT
    if (this.userVerified) flags |= FLAG_USER_VERIFIED
    if (this.backedUp) flags |= FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP
    if (attested) flags |= FLAG_ATTESTED_DATA

    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const head = Buffer.concat([rpIdHash, Buffer.from([flags]), counter])
    if (!attested) return head

    const credentialIdLength = Buffer.alloc(2)
    credentialIdLength.writeUInt16BE(this.credentialId.length)
    return Buffer.concat([
      head,
      Buffer.alloc(16), // aaguid: у ключа без аттестации он нулевой
      credentialIdLength,
      this.credentialId,
      this.coseKey,
    ])
  }
}

function clientData(type: string, challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8')
}
