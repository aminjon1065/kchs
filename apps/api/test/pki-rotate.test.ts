import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestResponse,
  type TestUser,
} from './helpers.js'

/**
 * Смена ключа УЦ Комитета (ADR-0224): плановая — новый выпускающий от того же корня,
 * прежний подписывает свой список отзыва дальше, его сертификаты проверяются; компрометация —
 * корень отзывает прежнего выпускающего, сертификат сотрудника перевыпускается при
 * следующем подписании тем же ключом устройства. Цепочки проверяет OpenSSL, как программа
 * чтения PDF вне Комитета.
 */
registerLifecycle()

const { mfaFactors, pkiAuthorities, pkiCertificates } = await import('../src/db-schema.js')
const { PkiCertificates } = await import('../src/modules/pki/domain/certificates.js')

const run = Date.now().toString(36)
let fx: TestContext
let workdir = ''
const secrets = new Map<string, string>()

interface Device {
  privateKey: KeyObject
  spki: Buffer
}

const raw = (response: TestResponse) => (response as unknown as { rawPayload: Buffer }).rawPayload
const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()}\n-----END ${label}-----\n`

function openssl(...args: string[]): string {
  try {
    return execFileSync('openssl', args, { cwd: workdir, stdio: 'pipe' }).toString('utf8')
  } catch (error) {
    const failed = error as { stdout?: Buffer; stderr?: Buffer }
    return `${failed.stdout?.toString('utf8') ?? ''}${failed.stderr?.toString('utf8') ?? ''}`
  }
}

async function codeOf(user: TestUser): Promise<string> {
  let secret = secrets.get(user.id)
  if (!secret) {
    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: user })
    secret = setup.json().secret as string
    await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: user,
      payload: { code: authenticator.generate(secret) },
    })
    secrets.set(user.id, secret)
  }
  await db().update(mfaFactors).set({ lastStep: null }).where(eq(mfaFactors.userId, user.id))
  return authenticator.generate(secret)
}

async function enroll(user: TestUser): Promise<{ device: Device; id: string; der: Buffer }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const device = { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }) }
  const challenge = await call(fx.app, {
    method: 'POST',
    url: '/me/certificates/challenge',
    as: user,
    payload: {},
  })
  const text = challenge.json().challenge as string
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/certificates',
    as: user,
    payload: {
      publicKey: device.spki.toString('base64'),
      challenge: text,
      proof: sign('sha256', Buffer.from(text, 'utf8'), privateKey).toString('base64'),
      deviceLabel: `Ноутбук ${run}`,
      code: await codeOf(user),
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  const record = response.json()
  return { device, id: record.id, der: Buffer.from(record.certificate, 'base64') }
}

async function fetchDer(url: string): Promise<Buffer> {
  const response = await call(fx.app, { url })
  expect(response.statusCode, `${url}: ${response.body}`).toBe(200)
  return raw(response)
}

/**
 * Проверка цепочки сертификата сотрудника по корню, выпускающему и спискам отзыва обоих —
 * как у программы чтения PDF: «OK» или причина отказа.
 */
async function verify(certificate: Buffer, issuerPath: string): Promise<string> {
  writeFileSync(join(workdir, 'root.pem'), pem('CERTIFICATE', await fetchDer('/pki/root.crt')))
  writeFileSync(
    join(workdir, 'issuing.pem'),
    pem('CERTIFICATE', await fetchDer(`/pki/${issuerPath}.crt`)),
  )
  writeFileSync(
    join(workdir, 'crls.pem'),
    pem('X509 CRL', await fetchDer('/pki/root.crl')) +
      pem('X509 CRL', await fetchDer(`/pki/${issuerPath}.crl`)),
  )
  writeFileSync(join(workdir, 'leaf.pem'), pem('CERTIFICATE', certificate))
  return openssl(
    'verify',
    '-crl_check_all',
    '-purpose',
    'any',
    '-CAfile',
    'root.pem',
    '-untrusted',
    'issuing.pem',
    '-CRLfile',
    'crls.pem',
    'leaf.pem',
  )
}

const fingerprint = (der: Buffer) => createHash('sha256').update(der).digest('hex')

const rotate = (as: TestUser, mode: 'planned' | 'compromise') =>
  call(fx.app, {
    method: 'POST',
    url: '/admin/pki/rotate',
    as,
    payload: { mode, reason: `Проверка смены ключа ${run}` },
  })

let first: { device: Device; id: string; der: Buffer }
let second: { device: Device; id: string; der: Buffer }
let firstIssuer = ''
let secondPath = ''

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'kchs-pki-rotate-'))
  fx = await setupFixture()
  const created = await call(fx.app, { method: 'POST', url: '/admin/pki/init', as: fx.admin })
  expect(created.statusCode, created.body).toBe(200)
  firstIssuer = created.json().issuers[0].fingerprint
  first = await enroll(fx.users.member)
})

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

describe('плановая смена ключа выпускающего', () => {
  it('новый выпускающий от того же корня; прежний остаётся по своим адресам', async () => {
    expect((await rotate(fx.users.member, 'planned')).statusCode).toBe(403)
    const before = (await call(fx.app, { url: '/pki/status', as: fx.admin })).json()
    const rotated = await rotate(fx.admin, 'planned')
    expect(rotated.statusCode, rotated.body).toBe(200)
    const status = rotated.json()
    expect(status.rootFingerprint).toBe(before.rootFingerprint)
    expect(status.issuers).toHaveLength(2)
    const [current, previous] = status.issuers
    expect(current).toMatchObject({ current: true, revokedAt: null })
    expect(current.fingerprint).not.toBe(firstIssuer)
    expect(current.path).toMatch(/^issuers\/[0-9a-f]{16}$/)
    expect(previous).toMatchObject({
      fingerprint: firstIssuer,
      path: 'issuing',
      reason: 'planned',
      revokedAt: null,
    })
    secondPath = current.path
    // Прежний адрес — прежний выпускающий: он вшит в выданные им сертификаты
    expect(fingerprint(await fetchDer('/pki/issuing.crt'))).toBe(firstIssuer)
    expect(fingerprint(await fetchDer(`/pki/${secondPath}.crt`))).toBe(current.fingerprint)
  })

  it('прежние сертификаты проверяются, прежний список отзыва ведётся дальше', async () => {
    expect(await verify(first.der, 'issuing')).toContain('OK')
    second = await enroll(fx.users.viewer)
    expect(await verify(second.der, secondPath)).toContain('OK')
    // Сертификат прежнего выпускающего не проходит по новому — цепочки разные
    expect(await verify(first.der, secondPath)).not.toMatch(/: OK/)

    const revoked = await call(fx.app, {
      method: 'POST',
      url: `/me/certificates/${first.id}/revoke`,
      as: fx.users.member,
      payload: { reason: 'Ноутбук утерян' },
    })
    expect(revoked.statusCode, revoked.body).toBe(200)
    expect(await verify(first.der, 'issuing')).toContain('certificate revoked')
    expect(await verify(second.der, secondPath)).toContain('OK')
  })
})

describe('смена ключа после компрометации', () => {
  it('корень отзывает прежнего выпускающего; подпись — перевыпущенным сертификатом', async () => {
    const rotated = await rotate(fx.admin, 'compromise')
    expect(rotated.statusCode, rotated.body).toBe(200)
    const [current, previous] = rotated.json().issuers
    expect(previous).toMatchObject({ path: secondPath, reason: 'compromise' })
    expect(previous.revokedAt).not.toBeNull()
    // Сертификат скомпрометированного выпускающего больше не проходит проверку
    expect(await verify(second.der, secondPath)).toContain('certificate revoked')

    // Следующее подписание: тот же ключ устройства получает сертификат нового выпускающего
    const owner = await PkiCertificates.owner(second.der)
    expect(owner).toMatchObject({ userId: fx.users.viewer.id, purpose: 'person', active: true })
    const reissued = owner?.current as Buffer
    expect(reissued).toBeDefined()
    expect(await verify(reissued, current.path)).toContain('OK')
    const [row] = await db()
      .select()
      .from(pkiCertificates)
      .where(eq(pkiCertificates.fingerprint, fingerprint(reissued)))
    expect(row?.issuerFingerprint).toBe(current.fingerprint)
    const { publicKeyDer } = (await import('../src/modules/pki/domain/asn1.js')).parseCertificate(
      reissued,
    )
    expect(publicKeyDer.equals(second.device.spki)).toBe(true)
    // Повторное подписание прежним сертификатом — тот же преемник, без нового выпуска
    const again = await PkiCertificates.owner(second.der)
    expect(again?.current?.equals(reissued)).toBe(true)
    const [old] = await db().select().from(pkiCertificates).where(eq(pkiCertificates.id, second.id))
    expect(old?.replacedBy).toBe(row?.id)
    expect(old?.revokedAt).not.toBeNull()
  })
})

describe('предупреждение о сроке ключей', () => {
  it('ключ службы штампов истекает — в состоянии УЦ и в «Здоровье системы»', async () => {
    const quiet = (await call(fx.app, { url: '/pki/status', as: fx.admin })).json()
    expect(quiet.expiring).toEqual([])
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString()
    await db().update(pkiAuthorities).set({ notAfter: soon }).where(eq(pkiAuthorities.kind, 'tsa'))
    const status = (await call(fx.app, { url: '/pki/status', as: fx.admin })).json()
    expect(status.expiring).toEqual([{ kind: 'tsa', notAfter: expect.any(String) }])
    const health = await call(fx.app, { url: '/admin/health', as: fx.admin })
    expect(health.statusCode, health.body).toBe(200)
    const pki = (health.json().components as Array<{ name: string; status: string }>).find(
      (item) => item.name === 'pki',
    )
    expect(pki?.status).toBe('degraded')
  })
})
