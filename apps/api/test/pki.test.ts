import { execFileSync } from 'node:child_process'
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
  X509Certificate,
} from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  engineHeadersFor,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestResponse,
  type TestUser,
  uploadFile,
} from './helpers.js'
import { createPeople, type ProcessPeople, publishDefinition } from './process-fixtures.js'

/**
 * УЦ Комитета (ADR-0218): создание УЦ, выпуск сертификата на ключ устройства по
 * доказательству владения и второму фактору, печать организации по способности, отзыв —
 * список отзыва и OCSP, штамп времени, и подпись КЭП ключом устройства: платформа отдаёт
 * подписываемые атрибуты, собирает CMS из подписи браузера и просит движок встроить её со
 * списками отзыва (PAdES-B-LT). Ключ «устройства» здесь — ключ Node: браузер подписывает
 * тем же RSASSA-PKCS1-v1_5/SHA-256.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { auditLog, documentQesSessions, integrations, mfaFactors } = await import(
  '../src/db-schema.js'
)
const { listSubscribers } = await import('../src/kernel/events/bus.js')
const { registerPkiBackground } = await import('../src/modules/pki/module.js')
const { timestampRequest, timestampStatus } = await import(
  '../src/modules/integrations/domain/qes-authority.js'
)

const run = Date.now().toString(36)
let fx: TestContext
let people: ProcessPeople
let sealer: TestUser
let memoTypeId = ''
let workdir = ''

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

interface DeviceKey {
  privateKey: KeyObject
  spki: Buffer
}

interface Issued {
  key: DeviceKey
  record: Body
  der: Buffer
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const raw = (response: TestResponse) => (response as unknown as { rawPayload: Buffer }).rawPayload

function deviceKey(): DeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }) }
}

function openssl(...args: string[]): string {
  return execFileSync('openssl', args, { cwd: workdir, stdio: 'pipe' }).toString('utf8')
}

// ─── Второй фактор и выпуск ─────────────────────────────────────────────────

const secrets = new Map<string, string>()

/** Код второго фактора; защита от повтора кода сбрасывается — тест подтверждает часто. */
async function codeOf(user: TestUser): Promise<string> {
  let secret = secrets.get(user.id)
  if (!secret) {
    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: user })
    secret = setup.json().secret as string
    const enable = await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: user,
      payload: { code: authenticator.generate(secret) },
    })
    expect(enable.statusCode, enable.body).toBe(200)
    secrets.set(user.id, secret)
  }
  await db().update(mfaFactors).set({ lastStep: null }).where(eq(mfaFactors.userId, user.id))
  return authenticator.generate(secret)
}

async function enroll(
  user: TestUser,
  options: { purpose?: 'person' | 'seal'; code?: string | null; proofKey?: DeviceKey } = {},
): Promise<{ response: TestResponse; key: DeviceKey }> {
  const key = deviceKey()
  const purpose = options.purpose ?? 'person'
  const challenge = await call(fx.app, {
    method: 'POST',
    url: '/me/certificates/challenge',
    as: user,
    payload: { purpose },
  })
  if (challenge.statusCode !== 200) return { response: challenge, key }
  const text = challenge.json().challenge as string
  const proof = sign('sha256', Buffer.from(text, 'utf8'), (options.proofKey ?? key).privateKey)
  const code = options.code === undefined ? await codeOf(user) : options.code
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/certificates',
    as: user,
    payload: {
      publicKey: key.spki.toString('base64'),
      challenge: text,
      proof: proof.toString('base64'),
      deviceLabel: `Ноутбук ${run}`,
      purpose,
      ...(code ? { code } : {}),
    },
  })
  return { response, key }
}

async function issued(user: TestUser, purpose: 'person' | 'seal' = 'person'): Promise<Issued> {
  const { response, key } = await enroll(user, { purpose })
  expect(response.statusCode, response.body).toBe(200)
  const record = response.json()
  return { key, record, der: Buffer.from(record.certificate, 'base64') }
}

// ─── Документ и сеанс КЭП ──────────────────────────────────────────────────

const engine = (path: string, payload: Record<string, unknown>) =>
  call(fx.app, { method: 'POST', url: path, headers: engineHeadersFor(path), payload })

const sessionPath = (id: string, tail: string) =>
  `/api/v1/internal/documents/signature-sessions/${id}/${tail}`

function page(method: 'GET' | 'POST', id: string, tail: string, ticket: string, payload?: object) {
  return call(fx.app, {
    method,
    url: `/qes/sessions/${id}/${tail}?t=${encodeURIComponent(ticket)}`,
    ...(payload ? { payload } : {}),
  })
}

const ticketOf = (signingUrl: string) => new URL(signingUrl).searchParams.get('t') ?? ''

async function publishQualified(key: string, signer: TestUser) {
  await publishDefinition(fx, {
    version: 1,
    key,
    objectType: 'document',
    name: { ru: `КЭП ${key}` },
    start: 'sign',
    steps: {
      sign: {
        type: 'sign',
        name: { ru: 'Подпись КЭП' },
        mode: 'sequential',
        assignees: [`user:${signer.id}`],
        requireMfa: true,
        signatureKind: 'qualified',
        next: 'end',
      },
      end: { type: 'end', outcome: 'completed' },
    },
  })
}

/** Записка с PDF-основой на маршруте КЭП; возвращает документ и шаг подписанта. */
async function routedMemo(definitionKey: string, signer: TestUser) {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as: people.author,
    payload: { typeId: memoTypeId, subject: `Записка ключом устройства ${run}` },
  })
  expect(created.statusCode, created.body).toBe(200)
  const doc = (
    await call(fx.app, { url: `/documents/${created.json().id}`, as: people.author })
  ).json() as Body
  const main = await uploadFile(fx.app, people.author, {
    spaceId: doc.spaceId,
    name: `записка-${run}.pdf`,
    content: '%PDF-1.4 записка на подпись ключом устройства',
    mime: 'application/pdf',
    attachToObjectId: doc.id,
  })
  const added = await call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/versions`,
    as: people.author,
    payload: { mainFileId: main.id, attachmentIds: [] },
  })
  expect(added.statusCode, added.body).toBe(200)
  const started = await call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/routes`,
    as: people.author,
    payload: { definitionKey },
  })
  return { doc, started }
}

async function qualifiedStepId(as: TestUser, instanceId: string): Promise<string> {
  const view = await call(fx.app, { url: `/processes/${instanceId}`, as })
  expect(view.statusCode, view.body).toBe(200)
  const step = (view.json().myActions as Body[]).find((item) => item.qualified)
  expect(step).toBeDefined()
  return step.stepId as string
}

async function startSession(as: TestUser, documentId: string, stepId: string, seal = false) {
  return call(fx.app, {
    method: 'POST',
    url: `/documents/${documentId}/qes-sessions`,
    as,
    payload: { stepId, ...(seal ? { seal: true } : {}) },
  })
}

/** Сертификат устройства принят → движок подготовил PDF: сеанс ждёт подписи. */
async function toAwaitingSignature(session: Body, certificate: Buffer) {
  const ticket = ticketOf(session.signingUrl)
  const picked = await page('POST', session.id, 'certificate', ticket, {
    certificate: certificate.toString('base64'),
  })
  expect(picked.statusCode, picked.body).toBe(200)
  expect(picked.json().state).toBe('preparing')
  const plan = await engine(sessionPath(session.id, 'start'), { step: 'prepare' })
  expect(plan.statusCode, plan.body).toBe(200)
  const digest = sha256(Buffer.from(`документ ${session.id}`))
  const prepared = await engine(sessionPath(session.id, 'done'), {
    step: 'prepare',
    status: 'ready',
    digest,
    reservedStart: 1200,
    reservedEnd: 1200 + 65538,
    size: 90_000,
    sha256: sha256(Buffer.from('prepared')),
  })
  expect(prepared.statusCode, prepared.body).toBe(200)
  return { ticket, digest }
}

function certificateReport(der: Buffer, owner: string) {
  const x509 = new X509Certificate(der)
  return {
    owner,
    organization: null,
    subject: x509.subject.replace(/\n/g, ', '),
    issuer: x509.issuer.replace(/\n/g, ', '),
    serial: x509.serialNumber.toLowerCase(),
    notBefore: new Date(x509.validFrom).toISOString(),
    notAfter: new Date(x509.validTo).toISOString(),
    fingerprint: sha256(der),
  }
}

function validation() {
  return {
    intact: true,
    valid: true,
    trusted: true,
    revocation: 'good',
    timestampAt: new Date().toISOString(),
    coverage: 'entire_file',
    modification: 'none',
    problem: null,
    checkedAt: new Date().toISOString(),
  }
}

// ─── Подготовка ─────────────────────────────────────────────────────────────

let root: X509Certificate
let issuing: X509Certificate
let boss: Issued
let other: Issued
let seal: Issued

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'kchs-pki-'))
  fx = await setupFixture()
  // Внешний УЦ прошлых прогонов выключен: подписывает УЦ Комитета
  await db().update(integrations).set({ enabled: false }).where(eq(integrations.kind, 'qes_ca'))
  people = await createPeople(fx, run)
  sealer = people.registrar
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  memoTypeId =
    (list.json().items as Array<{ id: string; key: string }>).find((item) => item.key === 'memo')
      ?.id ?? ''
  expect(memoTypeId).not.toBe('')
  await publishQualified(`pki_boss_${run}`, people.boss)
  await publishQualified(`pki_seal_${run}`, sealer)
})

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

// ─── Проверки ───────────────────────────────────────────────────────────────

describe('создание УЦ', () => {
  it('до создания выпуска нет; создаёт только администратор системы, один раз', async () => {
    const before = await call(fx.app, { url: '/pki/status', as: people.boss })
    expect(before.json()).toMatchObject({ initialized: false, rootFingerprint: null })
    expect((await call(fx.app, { url: '/pki/root.crt' })).statusCode).toBe(409)
    const challenge = await call(fx.app, {
      method: 'POST',
      url: '/me/certificates/challenge',
      as: people.boss,
      payload: {},
    })
    expect(challenge.statusCode).toBe(409)

    const denied = await call(fx.app, { method: 'POST', url: '/admin/pki/init', as: people.boss })
    expect(denied.statusCode).toBe(403)
    const created = await call(fx.app, { method: 'POST', url: '/admin/pki/init', as: fx.admin })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json()).toMatchObject({ initialized: true, active: 0 })
    const again = await call(fx.app, { method: 'POST', url: '/admin/pki/init', as: fx.admin })
    expect(again.json().rootFingerprint).toBe(created.json().rootFingerprint)

    const [initAudit] = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.action, 'pki.initialized'))
    expect(initAudit).toBeDefined()
  })

  it('корневой и выпускающий — без входа; цепочка сходится, отпечаток совпадает', async () => {
    const rootResponse = await call(fx.app, { url: '/pki/root.crt' })
    expect(rootResponse.statusCode).toBe(200)
    expect(rootResponse.headers['content-type']).toBe('application/pkix-cert')
    root = new X509Certificate(raw(rootResponse))
    issuing = new X509Certificate(raw(await call(fx.app, { url: '/pki/issuing.crt' })))
    expect(root.ca).toBe(true)
    expect(issuing.ca).toBe(true)
    expect(root.verify(root.publicKey)).toBe(true)
    expect(issuing.checkIssued(root)).toBe(true)
    expect(issuing.verify(root.publicKey)).toBe(true)
    const status = (await call(fx.app, { url: '/pki/status', as: people.boss })).json()
    expect(status.rootFingerprint).toBe(sha256(root.raw))
  })
})

describe('выпуск сертификата на ключ устройства', () => {
  it('без кода второго фактора и с чужим доказательством — отказ', async () => {
    const noCode = await enroll(people.boss, { code: null })
    expect(noCode.response.statusCode, noCode.response.body).toBe(400)
    const forged = await enroll(people.boss, { proofKey: deviceKey() })
    expect(forged.response.statusCode, forged.response.body).toBe(400)
    const mine = await call(fx.app, { url: '/me/certificates', as: people.boss })
    expect(mine.json().items).toEqual([])
  })

  it('сертификат сотрудника: выпущен УЦ Комитета, на его ключ, с отзывом и OCSP', async () => {
    boss = await issued(people.boss)
    expect(boss.record).toMatchObject({
      purpose: 'person',
      state: 'active',
      userId: people.boss.id,
    })
    const x509 = new X509Certificate(boss.der)
    expect(x509.checkIssued(issuing)).toBe(true)
    expect(x509.verify(issuing.publicKey)).toBe(true)
    expect(x509.ca).toBe(false)
    expect(x509.subject).toContain('boss_')
    expect(Buffer.from(x509.publicKey.export({ type: 'spki', format: 'der' }))).toEqual(
      boss.key.spki,
    )
    expect(x509.keyUsage).toContain('1.3.6.1.5.5.7.3.4')
    expect(x509.infoAccess).toMatch(/OCSP - URI:\S+\/api\/v1\/pki\/ocsp/)

    const listed = await call(fx.app, { url: '/me/certificates', as: people.boss })
    expect(listed.json().items.map((item: Body) => item.id)).toEqual([boss.record.id])
    other = await issued(people.signer)
  })

  it('печать организации — только со способностью «Печать организации»', async () => {
    const denied = await enroll(sealer, { purpose: 'seal' })
    expect(denied.response.statusCode).toBe(403)
    const role = await call(fx.app, {
      method: 'POST',
      url: '/roles',
      as: fx.admin,
      payload: { name: { ru: `Хранитель печати ${run}` }, capabilities: ['documents.seal'] },
    })
    expect(role.statusCode, role.body).toBe(200)
    const assigned = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${sealer.id}`,
      as: fx.admin,
      payload: { roleKeys: ['registrar', role.json().key] },
    })
    expect(assigned.statusCode, assigned.body).toBe(200)
    seal = await issued(sealer, 'seal')
    expect(seal.record.purpose).toBe('seal')
    expect(new X509Certificate(seal.der).subject).toMatch(/Печать организации/)
  })

  it('чужие сертификаты: отозвать нельзя; список всех — у управляющего пользователями', async () => {
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/me/certificates/${boss.record.id}/revoke`,
      as: people.signer,
      payload: {},
    })
    expect(foreign.statusCode).toBe(404)
    const notAdmin = await call(fx.app, { url: '/admin/pki/certificates', as: people.boss })
    expect(notAdmin.statusCode).toBe(403)
    const all = await call(fx.app, {
      url: '/admin/pki/certificates?state=active',
      as: fx.admin,
    })
    expect(all.statusCode, all.body).toBe(200)
    expect(
      all
        .json()
        .items.map((item: Body) => item.id)
        .sort(),
    ).toEqual([boss.record.id, other.record.id, seal.record.id].sort())
  })
})

describe('штамп времени', () => {
  it('служба штампов отвечает «выдан» на запрос RFC 3161', async () => {
    const request = timestampRequest(Buffer.alloc(32, 7), Buffer.from('0102030405060708', 'hex'))
    const response = await call(fx.app, {
      method: 'POST',
      url: '/pki/tsa',
      headers: { 'content-type': 'application/timestamp-query' },
      payload: request,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toBe('application/timestamp-reply')
    expect(timestampStatus(raw(response))).toBe(0)
  })
})

describe('подпись КЭП ключом устройства', () => {
  it('страница без агента; чужой сертификат — отказ; CMS собирается из подписи браузера', async () => {
    const { doc, started } = await routedMemo(`pki_boss_${run}`, people.boss)
    expect(started.statusCode, started.body).toBe(200)
    const stepId = await qualifiedStepId(people.boss, started.json().id)
    const opened = await startSession(people.boss, doc.id, stepId)
    expect(opened.statusCode, opened.body).toBe(200)
    const session = opened.json()
    const ticket = ticketOf(session.signingUrl)

    const html = await call(fx.app, {
      url: `/qes/sessions/${session.id}/page?t=${encodeURIComponent(ticket)}`,
      as: people.boss,
    })
    expect(html.statusCode, html.body).toBe(200)
    expect(html.body).toContain('kchs-pki')
    const csp = html.headers['content-security-policy'] as string
    expect(csp).toMatch(new RegExp(`connect-src \\S+/api/v1/qes/sessions/${session.id}/;`))

    const foreign = await page('POST', session.id, 'certificate', ticket, {
      certificate: other.der.toString('base64'),
    })
    expect(foreign.statusCode, foreign.body).toBe(409)
    const sealCert = await page('POST', session.id, 'certificate', ticket, {
      certificate: seal.der.toString('base64'),
    })
    expect(sealCert.statusCode, sealCert.body).toBe(409)

    await toAwaitingSignature(session, boss.der)
    const state = await page('GET', session.id, 'state', ticket)
    expect(state.json()).toMatchObject({ state: 'awaiting_signature', mode: 'signed-attributes' })
    const attributes = Buffer.from(state.json().dataToSign as string, 'base64')
    // SET OF подписываемых атрибутов (DER): подписывает именно его браузер
    expect(attributes[0]).toBe(0x31)

    const wrong = sign('sha256', attributes, other.key.privateKey)
    const refused = await page('POST', session.id, 'result', ticket, {
      signature: wrong.toString('base64'),
    })
    expect(refused.statusCode, refused.body).toBe(400)
    const signature = sign('sha256', attributes, boss.key.privateKey)
    const sent = await page('POST', session.id, 'result', ticket, {
      signature: signature.toString('base64'),
    })
    expect(sent.statusCode, sent.body).toBe(200)
    expect(sent.json().state).toBe('verifying')

    const plan = await engine(sessionPath(session.id, 'start'), { step: 'attach' })
    expect(plan.statusCode, plan.body).toBe(200)
    expect(plan.json()).toMatchObject({
      status: 'attach',
      certificateSha256: sha256(boss.der),
      timestamp: { url: '/api/v1/pki/tsa' },
      policy: { revocation: 'hard-fail', fetchRevocation: false, ltv: true },
    })
    expect(plan.json().policy.trustRootsPem).toHaveLength(1)
    expect(plan.json().policy.crls).toHaveLength(2)
    const cms = Buffer.from(plan.json().cms as string, 'base64')
    expect(cms.includes(boss.der)).toBe(true)
    expect(cms.includes(issuing.raw)).toBe(true)
    expect(cms.includes(signature)).toBe(true)

    const done = await engine(sessionPath(session.id, 'done'), {
      step: 'attach',
      status: 'ready',
      size: 92_000,
      sha256: sha256(Buffer.from('signed pdf')),
      certificate: certificateReport(boss.der, 'boss'),
      validation: validation(),
    })
    expect(done.statusCode, done.body).toBe(200)
    const [row] = await db()
      .select({ state: documentQesSessions.state })
      .from(documentQesSessions)
      .where(eq(documentQesSessions.id, session.id))
    expect(row?.state).toBe('signed')
  })

  it('печать: ставит держатель печати её ключом; без способности сеанс печати не начать', async () => {
    const { doc, started } = await routedMemo(`pki_seal_${run}`, sealer)
    expect(started.statusCode, started.body).toBe(200)
    const stepId = await qualifiedStepId(sealer, started.json().id)

    // Сеанс «своей подписью» — ключ печати не подходит
    const personal = (await startSession(sealer, doc.id, stepId)).json()
    const mismatch = await page('POST', personal.id, 'certificate', ticketOf(personal.signingUrl), {
      certificate: seal.der.toString('base64'),
    })
    expect(mismatch.statusCode, mismatch.body).toBe(409)

    const opened = await startSession(sealer, doc.id, stepId, true)
    expect(opened.statusCode, opened.body).toBe(200)
    const { ticket } = await toAwaitingSignature(opened.json(), seal.der)
    const state = await page('GET', opened.json().id, 'state', ticket)
    const attributes = Buffer.from(state.json().dataToSign as string, 'base64')
    const sent = await page('POST', opened.json().id, 'result', ticket, {
      signature: sign('sha256', attributes, seal.key.privateKey).toString('base64'),
    })
    expect(sent.statusCode, sent.body).toBe(200)

    const { doc: bossDoc, started: bossRoute } = await routedMemo(`pki_boss_${run}`, people.boss)
    const bossStep = await qualifiedStepId(people.boss, bossRoute.json().id)
    const denied = await startSession(people.boss, bossDoc.id, bossStep, true)
    expect(denied.statusCode, denied.body).toBe(403)
  })
})

describe('отзыв', () => {
  it('отозванный — в списке отзыва и «revoked» в OCSP; подписать им нельзя', async () => {
    const revoked = await call(fx.app, {
      method: 'POST',
      url: `/me/certificates/${boss.record.id}/revoke`,
      as: people.boss,
      payload: { reason: 'ноутбук утерян' },
    })
    expect(revoked.statusCode, revoked.body).toBe(200)
    expect(revoked.json()).toMatchObject({ state: 'revoked', revocationReason: 'ноутбук утерян' })

    const crl = await call(fx.app, { url: '/pki/issuing.crl' })
    expect(crl.statusCode).toBe(200)
    writeFileSync(join(workdir, 'issuing.crl'), raw(crl))
    writeFileSync(join(workdir, 'issuing.pem'), issuing.toString())
    writeFileSync(join(workdir, 'root.pem'), root.toString())
    const crlText = openssl('crl', '-inform', 'DER', '-in', 'issuing.crl', '-noout', '-text')
    const serial = new X509Certificate(boss.der).serialNumber.toUpperCase()
    expect(crlText.toUpperCase().replace(/:/g, '')).toContain(serial)

    const ocspStatus = async (der: Buffer) => {
      const name = `leaf-${randomUUID()}`
      writeFileSync(join(workdir, `${name}.pem`), new X509Certificate(der).toString())
      openssl(
        'ocsp',
        '-issuer',
        'issuing.pem',
        '-cert',
        `${name}.pem`,
        '-no_nonce',
        '-reqout',
        `${name}.req`,
      )
      const response = await call(fx.app, {
        method: 'POST',
        url: '/pki/ocsp',
        headers: { 'content-type': 'application/ocsp-request' },
        payload: readFileSync(join(workdir, `${name}.req`)),
      })
      expect(response.statusCode, response.body).toBe(200)
      writeFileSync(join(workdir, `${name}.resp`), raw(response))
      return openssl('ocsp', '-respin', `${name}.resp`, '-resp_text', '-noverify')
    }
    expect(await ocspStatus(boss.der)).toMatch(/Cert Status: revoked/)
    expect(await ocspStatus(seal.der)).toMatch(/Cert Status: good/)

    const { doc, started } = await routedMemo(`pki_boss_${run}`, people.boss)
    const stepId = await qualifiedStepId(people.boss, started.json().id)
    const session = (await startSession(people.boss, doc.id, stepId)).json()
    const refused = await page('POST', session.id, 'certificate', ticketOf(session.signingUrl), {
      certificate: boss.der.toString('base64'),
    })
    expect(refused.statusCode, refused.body).toBe(409)
  })

  it('заблокированный сотрудник: его сертификаты отзываются подписчиком', async () => {
    const blocked = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${people.signer.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)
    // Подписчики воркера в тестовом приложении не зарегистрированы — регистрируем как воркер
    const find = () => listSubscribers().find((item) => item.name === 'pki-revoke-blocked')
    if (!find()) registerPkiBackground()
    const subscriber = find()
    expect(subscriber).toBeDefined()
    const [event] = await db().execute<{ event: Body }>(
      sql`SELECT event FROM ops.outbox
           WHERE event->>'type' = 'user.blocked' AND event->'object'->>'id' = ${people.signer.id}
           ORDER BY id DESC LIMIT 1`,
    )
    expect(event).toBeDefined()
    await subscriber?.handle(event?.event)

    const list = await call(fx.app, { url: '/admin/pki/certificates?state=revoked', as: fx.admin })
    const mine = (list.json().items as Body[]).find((item) => item.id === other.record.id)
    expect(mine).toMatchObject({ state: 'revoked' })
    const audits = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'pki.certificate_revoked'),
          eq(auditLog.objectId, people.signer.id),
        ),
      )
    expect(audits.length).toBeGreaterThan(0)
  })
})
