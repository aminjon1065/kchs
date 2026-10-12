import { execFileSync } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  engineHeadersFor,
  engineJobHeaders,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'
import { createPeople, inboxOf, type ProcessPeople, publishDefinition } from './process-fixtures.js'

/**
 * Квалифицированная подпись (ADR-0205): без подключённого УЦ маршрут с КЭП не
 * запускается; с ним — сеанс подписания, страница со своей CSP, сертификат и CMS по
 * билету, шаги движка по токену задания. Подпись становится решением шага, только
 * когда движок её встроил и проверил; подделанная CMS, чужой билет, чужой токен и
 * попытка «подписать» кнопкой — отказ. Тестовый УЦ — корень и сертификаты openssl.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const {
  auditLog,
  documentQesSessions,
  documentSignatures,
  documentVersions,
  files,
  fileVersions,
  integrations,
} = await import('../src/db-schema.js')
const { issueSigningTicket } = await import('../src/kernel/signature/ticket.js')
const { timestampRequest, timestampStatus } = await import(
  '../src/modules/integrations/domain/qes-authority.js'
)

const run = Date.now().toString(36)
let fx: TestContext
let people: ProcessPeople
let memoTypeId = ''

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

// ─── Тестовый УЦ (openssl) и заглушка TSA ───────────────────────────────────

interface TestCa {
  rootPem: string
  signerDer: Buffer
  otherDer: Buffer
  caDer: Buffer
}

let ca: TestCa
let workdir = ''
let tsa: Server
let tsaUrl = ''
/** Ответ заглушки TSA: 0 — выдан, 2 — отказ. */
let tsaStatus = 0

function openssl(...args: string[]): void {
  execFileSync('openssl', args, { cwd: workdir, stdio: 'pipe' })
}

function makeCa(): TestCa {
  workdir = mkdtempSync(join(tmpdir(), 'kchs-qes-'))
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-utf8',
    '-keyout',
    'root.key',
    '-out',
    'root.pem',
    '-days',
    '3650',
    '-subj',
    '/CN=Тестовый УЦ Комитета/C=TJ',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  )
  writeFileSync(
    join(workdir, 'leaf.cnf'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n',
  )
  const leaf = (name: string, subject: string) => {
    openssl(
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-utf8',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      subject,
    )
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'root.pem',
      '-CAkey',
      'root.key',
      '-CAcreateserial',
      '-days',
      '365',
      '-extfile',
      'leaf.cnf',
      '-outform',
      'DER',
      '-out',
      `${name}.der`,
    )
    return readFileSync(join(workdir, `${name}.der`))
  }
  const signerDer = leaf('signer', '/CN=Саидзода Тахир Раҳимович/O=Комитет по ЧС и ГО/C=TJ')
  const otherDer = leaf('other', '/CN=Посторонний Сертификат/C=TJ')
  openssl('x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der')
  return {
    rootPem: readFileSync(join(workdir, 'root.pem'), 'utf8'),
    signerDer,
    otherDer,
    caDer: readFileSync(join(workdir, 'root.der')),
  }
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

// ─── Помощники ──────────────────────────────────────────────────────────────

const engine = (path: string, payload: Record<string, unknown>) =>
  call(fx.app, { method: 'POST', url: path, headers: engineHeadersFor(path), payload })

const sessionPath = (id: string, tail: string) =>
  `/api/v1/internal/documents/signature-sessions/${id}/${tail}`

/** Маршруты страницы — по билету, без входа. */
function page(method: 'GET' | 'POST', id: string, tail: string, ticket: string, payload?: object) {
  return call(fx.app, {
    method,
    url: `/qes/sessions/${id}/${tail}?t=${encodeURIComponent(ticket)}`,
    ...(payload ? { payload } : {}),
  })
}

function ticketOf(signingUrl: string): string {
  return new URL(signingUrl).searchParams.get('t') ?? ''
}

async function createIntegration(config: Record<string, unknown>) {
  return call(fx.app, {
    method: 'POST',
    url: '/integrations',
    as: fx.admin,
    payload: {
      key: `qes-ca-${run}-${randomUUID().slice(0, 6)}`,
      kind: 'qes_ca',
      name: 'Тестовый удостоверяющий центр',
      enabled: true,
      config,
      secrets: {},
    },
  })
}

function caConfig(overrides: Record<string, unknown> = {}) {
  return {
    agentUrl: 'http://127.0.0.1:24321',
    tsaUrl,
    trustRoots: ca.rootPem,
    revocation: 'hard-fail',
    fetchRevocation: true,
    ...overrides,
  }
}

async function publishQualified(key: string, mode: 'parallel' | 'sequential', signers: TestUser[]) {
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
        mode,
        assignees: signers.map((user) => `user:${user.id}`),
        requireMfa: true,
        signatureKind: 'qualified',
        next: 'end',
      },
      end: { type: 'end', outcome: 'completed' },
    },
  })
}

/** Служебная записка с PDF-основой: представление версии — сам файл. */
async function memoWithPdf(): Promise<Body> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as: people.author,
    payload: { typeId: memoTypeId, subject: `Записка на КЭП ${run}` },
  })
  expect(created.statusCode, created.body).toBe(200)
  const doc = (
    await call(fx.app, { url: `/documents/${created.json().id}`, as: people.author })
  ).json() as Body
  const main = await uploadFile(fx.app, people.author, {
    spaceId: doc.spaceId,
    name: `записка-${run}.pdf`,
    content: '%PDF-1.4 записка на квалифицированную подпись',
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
  return { ...doc, mainFileId: main.id }
}

async function startRoute(documentId: string, definitionKey: string) {
  return call(fx.app, {
    method: 'POST',
    url: `/documents/${documentId}/routes`,
    as: people.author,
    payload: { definitionKey },
  })
}

async function myQualifiedStep(as: TestUser, instanceId: string): Promise<Body> {
  const view = await call(fx.app, { url: `/processes/${instanceId}`, as })
  expect(view.statusCode, view.body).toBe(200)
  return (view.json().myActions as Body[]).find((item) => item.qualified)
}

async function startSession(as: TestUser, documentId: string, stepId: string) {
  return call(fx.app, {
    method: 'POST',
    url: `/documents/${documentId}/qes-sessions`,
    as,
    payload: { stepId },
  })
}

/** Сертификат → подготовка движком → CMS агента: сеанс ждёт встраивания. */
async function toVerifying(session: Body, certificate = ca.signerDer) {
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
  const state = await page('GET', session.id, 'state', ticket)
  expect(state.json()).toMatchObject({
    state: 'awaiting_signature',
    mode: 'cms-detached',
    digestAlgorithm: 'sha256',
    dataToSign: Buffer.from(digest, 'hex').toString('base64'),
  })
  const cms = Buffer.from(`CMS агента ${session.id}`).toString('base64')
  const sent = await page('POST', session.id, 'result', ticket, { cms })
  expect(sent.statusCode, sent.body).toBe(200)
  expect(sent.json().state).toBe('verifying')
  return { ticket, plan: plan.json() as Body, digest, cms }
}

function validation(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

function certificateReport(der: Buffer, owner = 'Саидзода Тахир Раҳимович') {
  return {
    owner,
    organization: 'Комитет по ЧС и ГО',
    subject: `CN=${owner}`,
    issuer: 'CN=Тестовый УЦ Комитета',
    serial: '1a2b3c',
    notBefore: new Date(Date.now() - 86_400_000).toISOString(),
    notAfter: new Date(Date.now() + 300 * 86_400_000).toISOString(),
    fingerprint: sha256(der),
  }
}

async function attachDone(sessionId: string, report: Record<string, unknown>) {
  const done = await engine(sessionPath(sessionId, 'done'), { step: 'attach', ...report })
  expect(done.statusCode, done.body).toBe(200)
  const [row] = await db()
    .select()
    .from(documentQesSessions)
    .where(eq(documentQesSessions.id, sessionId))
  return row
}

async function signaturesOf(documentId: string): Promise<Body[]> {
  const response = await call(fx.app, {
    url: `/documents/${documentId}/signatures`,
    as: people.author,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

// ─── Подготовка ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  ca = makeCa()
  tsa = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      // Запрос — TimeStampReq; ответ — TimeStampResp с PKIStatus (без токена)
      response.writeHead(200, { 'content-type': 'application/timestamp-reply' })
      response.end(Buffer.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, tsaStatus]))
    })
  })
  await new Promise<void>((resolve) => tsa.listen(0, '127.0.0.1', resolve))
  tsaUrl = `http://127.0.0.1:${(tsa.address() as AddressInfo).port}/tsp`

  fx = await setupFixture()
  // База слота живёт между прогонами: УЦ прошлого прогона выключается
  await db().update(integrations).set({ enabled: false }).where(eq(integrations.kind, 'qes_ca'))
  people = await createPeople(fx, run)
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  memoTypeId =
    (list.json().items as Array<{ id: string; key: string }>).find((item) => item.key === 'memo')
      ?.id ?? ''
  expect(memoTypeId).not.toBe('')
  await publishQualified(`qes_one_${run}`, 'sequential', [people.boss])
  await publishQualified(`qes_two_${run}`, 'sequential', [people.boss, people.signer])
  await publishQualified(`qes_par_${run}`, 'parallel', [people.boss, people.signer])
})

afterAll(async () => {
  await db().update(integrations).set({ enabled: false }).where(eq(integrations.kind, 'qes_ca'))
  await new Promise<void>((resolve) => tsa.close(() => resolve()))
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

// ─── Проверки ───────────────────────────────────────────────────────────────

describe('запрос штампа времени без библиотек ASN.1', () => {
  it('TimeStampReq — DER с SHA-256 и nonce; статус ответа читается', () => {
    const request = timestampRequest(Buffer.alloc(32, 7), Buffer.from('8102030405060708', 'hex'))
    expect(request[0]).toBe(0x30)
    expect(request.includes(Buffer.from('608648016503040201', 'hex'))).toBe(true)
    // старший бит nonce сброшен — INTEGER положительный
    expect(request.includes(Buffer.from('02080102030405060708', 'hex'))).toBe(true)
    expect(timestampStatus(Buffer.from('30053003020100', 'hex'))).toBe(0)
    expect(() => timestampStatus(Buffer.from('0400', 'hex'))).toThrow()
  })
})

describe('без удостоверяющего центра', () => {
  it('маршрут с КЭП не запускается, сеанс не начинается — понятный отказ', async () => {
    const doc = await memoWithPdf()
    const started = await startRoute(doc.id, `qes_one_${run}`)
    expect(started.statusCode, started.body).toBe(409)
    expect(started.json().detail).toMatch(/удостоверяющий центр/)
    // Автор видит документ: отказ — из-за УЦ, а не из-за прав
    const session = await startSession(people.author, doc.id, randomUUID())
    expect(session.statusCode, session.body).toBe(409)
    expect(session.json().detail).toMatch(/удостоверяющий центр/)
  })
})

describe('интеграция «Удостоверяющий центр»', () => {
  it('конфигурация проверяется при записи; «Проверить соединение» — корни и TSA', async () => {
    const remote = await createIntegration(caConfig({ agentUrl: 'https://agent.example.org' }))
    expect(remote.statusCode, remote.body).toBe(400)
    const noRoots = await createIntegration(caConfig({ trustRoots: 'не PEM' }))
    expect(noRoots.statusCode, noRoots.body).toBe(400)

    const created = await createIntegration(caConfig())
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const ok = await call(fx.app, {
      method: 'POST',
      url: `/integrations/${id}/check`,
      as: fx.admin,
    })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true })
    expect(ok.json().message).toMatch(/Доверенных сертификатов: 1/)
    expect(ok.json().message).toMatch(/TSA выдал штамп/)

    tsaStatus = 2
    const refused = await call(fx.app, {
      method: 'POST',
      url: `/integrations/${id}/check`,
      as: fx.admin,
    })
    tsaStatus = 0
    expect(refused.json()).toMatchObject({ ok: false })
    expect(refused.json().message).toMatch(/отказал/)
    // Сертификат подписанта вместо корня — не сертификат УЦ
    const leafPem = `-----BEGIN CERTIFICATE-----\n${ca.signerDer.toString('base64')}\n-----END CERTIFICATE-----`
    const update = await call(fx.app, {
      method: 'PATCH',
      url: `/integrations/${id}`,
      as: fx.admin,
      payload: { config: caConfig({ trustRoots: leafPem }) },
    })
    expect(update.statusCode, update.body).toBe(200)
    const leafOnly = await call(fx.app, {
      method: 'POST',
      url: `/integrations/${id}/check`,
      as: fx.admin,
    })
    expect(leafOnly.json()).toMatchObject({ ok: false })
    expect(leafOnly.json().message).toMatch(/нет сертификата УЦ/)
    const restored = await call(fx.app, {
      method: 'PATCH',
      url: `/integrations/${id}`,
      as: fx.admin,
      payload: { config: caConfig() },
    })
    expect(restored.statusCode, restored.body).toBe(200)
  })
})

describe('подпись КЭП по маршруту', () => {
  let doc: Body
  let instanceId = ''
  let stepId = ''
  let failedSessionId = ''

  it('маршрут запускается; у подписанта — «Подписать КЭП», во «Входящих» — только отказ', async () => {
    doc = await memoWithPdf()
    const started = await startRoute(doc.id, `qes_one_${run}`)
    expect(started.statusCode, started.body).toBe(200)
    instanceId = started.json().id
    const step = await myQualifiedStep(people.boss, instanceId)
    expect(step).toMatchObject({ qualified: true, requireMfa: false })
    expect(step.actions).toContain('sign')
    stepId = step.stepId
    const [item] = await inboxOf(fx, people.boss, doc.id)
    expect(item?.actions.map((action) => action.key)).toEqual(['refuse'])
  })

  it('кнопкой «Подписать» шаг с КЭП не подписать — ни через маршрут, ни через «Входящие»', async () => {
    const plain = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${stepId}/act`,
      as: people.boss,
      payload: { action: 'sign', code: '000000' },
    })
    expect(plain.statusCode, plain.body).toBe(409)
    const [item] = await inboxOf(fx, people.boss, doc.id)
    const forged = await call(fx.app, {
      method: 'POST',
      url: `/inbox/${item?.id}/act`,
      as: people.boss,
      payload: { action: 'sign', payload: { qualifiedSessionId: randomUUID() } },
    })
    expect([400, 409]).toContain(forged.statusCode)
    expect(await signaturesOf(doc.id)).toEqual([])
  })

  it('сеанс: ссылка только подписанту; посторонний не видит; страница со своей CSP', async () => {
    const stranger = await startSession(fx.users.stranger, doc.id, stepId)
    expect([403, 404]).toContain(stranger.statusCode)
    const notMine = await startSession(people.signer, doc.id, stepId)
    expect([403, 404, 409]).toContain(notMine.statusCode)

    const started = await startSession(people.boss, doc.id, stepId)
    expect(started.statusCode, started.body).toBe(200)
    const session = started.json()
    expect(session).toMatchObject({ state: 'awaiting_certificate', signatureId: null })
    expect(session.signingUrl).toContain(`/api/v1/qes/sessions/${session.id}/page?t=`)
    const foreign = await call(fx.app, {
      url: `/documents/${doc.id}/qes-sessions/${session.id}`,
      as: fx.users.stranger,
    })
    expect([403, 404]).toContain(foreign.statusCode)
    // Автор документа видит состояние, но не ссылку на чужое подписание
    const author = await call(fx.app, {
      url: `/documents/${doc.id}/qes-sessions/${session.id}`,
      as: people.author,
    })
    expect(author.statusCode, author.body).toBe(200)
    expect(author.json().signingUrl).toBeNull()

    const ticket = ticketOf(session.signingUrl)
    const html = await call(fx.app, {
      url: `/qes/sessions/${session.id}/page?t=${encodeURIComponent(ticket)}`,
      as: people.boss,
    })
    expect(html.statusCode, html.body).toBe(200)
    const csp = html.headers['content-security-policy'] as string
    expect(csp).toContain("default-src 'none'")
    expect(csp).toMatch(
      new RegExp(
        `connect-src http://127\\.0\\.0\\.1:24321/ \\S+/api/v1/qes/sessions/${session.id}/;`,
      ),
    )
    expect(csp).not.toContain('unsafe-inline')
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(html.body).toContain(`<script nonce="${nonce}">`)
    expect(html.headers['cache-control']).toBe('no-store')
    // Билет на другого сотрудника страницу не открывает
    const otherPage = await call(fx.app, {
      url: `/qes/sessions/${session.id}/page?t=${encodeURIComponent(ticket)}`,
      as: people.signer,
    })
    expect(otherPage.statusCode).toBe(404)
  })

  it('поддельный билет и агент: сертификат УЦ отвергнут, чужая CMS — подпись не встала', async () => {
    const started = await startSession(people.boss, doc.id, stepId)
    expect(started.statusCode, started.body).toBe(200)
    const session = started.json()
    failedSessionId = session.id
    const ticket = ticketOf(session.signingUrl)

    // Билет, подписанный не нашим ключом, и билет другого сеанса
    const forgedTicket = `${ticket.slice(0, -4)}AAAA`
    const forged = await page('GET', session.id, 'state', forgedTicket)
    expect(forged.statusCode).toBe(404)
    const otherSession = issueSigningTicket({
      sessionId: randomUUID(),
      userId: people.boss.id,
      expiresAt: Date.now() + 60_000,
    })
    expect((await page('GET', session.id, 'state', otherSession)).statusCode).toBe(404)
    const expired = issueSigningTicket({
      sessionId: session.id,
      userId: people.boss.id,
      expiresAt: Date.now() - 1000,
    })
    expect((await page('GET', session.id, 'state', expired)).statusCode).toBe(404)

    // Сертификат УЦ и мусор вместо сертификата подписанта
    const asCa = await page('POST', session.id, 'certificate', ticket, {
      certificate: ca.caDer.toString('base64'),
    })
    expect(asCa.statusCode, asCa.body).toBe(400)
    const garbage = await page('POST', session.id, 'certificate', ticket, {
      certificate: Buffer.from('не сертификат').toString('base64'),
    })
    expect(garbage.statusCode, garbage.body).toBe(400)
    // CMS раньше подготовки — не по порядку
    const early = await page('POST', session.id, 'result', ticket, { cms: 'QUJD' })
    expect(early.statusCode, early.body).toBe(409)

    const { plan } = await toVerifying(session)
    // Подделанное решение по настоящему сеансу, который движок ещё не проверил
    const [item] = await inboxOf(fx, people.boss, doc.id)
    const forgedDecision = await call(fx.app, {
      method: 'POST',
      url: `/inbox/${item?.id}/act`,
      as: people.boss,
      payload: { action: 'sign', payload: { qualifiedSessionId: session.id } },
    })
    expect([400, 409]).toContain(forgedDecision.statusCode)
    expect(await signaturesOf(doc.id)).toEqual([])
    expect(plan).toMatchObject({ status: 'prepare', fieldName: `kchs-${plan.fieldName.slice(5)}` })
    expect(plan.stampLines.join('\n')).toContain('Саидзода Тахир Раҳимович')
    expect(plan.url).toMatch(/\/api\/v1\/verify\/[0-9a-f-]{36}$/)

    // Токен задания чужого сеанса и плана — 403; без токена — 401
    const wrongScope = await call(fx.app, {
      method: 'POST',
      url: sessionPath(session.id, 'done'),
      headers: engineJobHeaders({ scope: `signature-session:${randomUUID()}` }),
      payload: { step: 'attach', status: 'ready' },
    })
    expect(wrongScope.statusCode).toBe(403)
    const noToken = await call(fx.app, {
      method: 'POST',
      url: sessionPath(session.id, 'done'),
      payload: { step: 'attach', status: 'ready' },
    })
    expect(noToken.statusCode).toBe(401)

    const attachPlan = await engine(sessionPath(session.id, 'start'), { step: 'attach' })
    expect(attachPlan.json()).toMatchObject({
      status: 'attach',
      certificateSha256: sha256(ca.signerDer),
      timestamp: { url: tsaUrl },
      policy: { revocation: 'hard-fail', fetchRevocation: true },
    })
    expect(attachPlan.json().policy.trustRootsPem).toHaveLength(1)

    // Движок не доверяет цепочке CMS — сеанс не удался, подписи нет, шаг ждёт
    const row = await attachDone(session.id, {
      status: 'invalid',
      reason: 'untrusted',
      error: 'Цепочка сертификата не доверенная',
      certificate: certificateReport(ca.otherDer, 'Посторонний Сертификат'),
      validation: validation({ trusted: false, revocation: 'unknown', problem: 'нет пути' }),
    })
    expect(row).toMatchObject({ state: 'failed', reason: 'untrusted' })
    expect(await signaturesOf(doc.id)).toEqual([])
    expect((await myQualifiedStep(people.boss, instanceId))?.stepId).toBe(stepId)
    const state = await page('GET', session.id, 'state', ticket)
    expect(state.json()).toMatchObject({ state: 'failed', reason: 'untrusted' })
  })

  it('«верный» отчёт по чужому сертификату или без доверия не становится подписью', async () => {
    const started = await startSession(people.boss, doc.id, stepId)
    const session = started.json()
    await toVerifying(session)
    // Движок говорит «готово», но сертификат в PDF не тот, что выбран в агенте
    const wrongCert = await attachDone(session.id, {
      status: 'ready',
      size: 91_000,
      sha256: sha256(Buffer.from('signed')),
      certificate: certificateReport(ca.otherDer),
      validation: validation(),
    })
    expect(wrongCert).toMatchObject({ state: 'failed', reason: 'certificate_mismatch' })

    const again = (await startSession(people.boss, doc.id, stepId)).json()
    await toVerifying(again)
    const revoked = await attachDone(again.id, {
      status: 'ready',
      size: 91_000,
      sha256: sha256(Buffer.from('signed')),
      certificate: certificateReport(ca.signerDer),
      validation: validation({ revocation: 'revoked', trusted: false }),
    })
    expect(revoked).toMatchObject({ state: 'failed', reason: 'invalid' })
    expect(await signaturesOf(doc.id)).toEqual([])
  })

  it('проверенная подпись — решение шага, запись КЭП с сертификатом, экземпляр и страница проверки', async () => {
    const started = await startSession(people.boss, doc.id, stepId)
    const session = started.json()
    const { ticket } = await toVerifying(session)
    // Повторная CMS по тому же сеансу — не по порядку
    expect((await page('POST', session.id, 'result', ticket, { cms: 'QUJD' })).statusCode).toBe(409)
    const row = await attachDone(session.id, {
      status: 'ready',
      size: 92_345,
      sha256: sha256(Buffer.from('signed pdf')),
      certificate: certificateReport(ca.signerDer),
      validation: validation(),
    })
    expect(row).toMatchObject({ state: 'signed', reason: null, cms: null })
    // Повтор отчёта — устаревший, второй подписи нет
    const stale = await engine(sessionPath(session.id, 'done'), {
      step: 'attach',
      status: 'ready',
      certificate: certificateReport(ca.signerDer),
      validation: validation(),
    })
    expect(stale.json()).toEqual({ ok: true, stale: true })

    const [signature, ...rest] = await signaturesOf(doc.id)
    expect(rest).toEqual([])
    expect(signature).toMatchObject({
      id: row?.signatureId,
      kind: 'qualified',
      mfa: false,
      certificate: { owner: 'Саидзода Тахир Раҳимович', fingerprint: sha256(ca.signerDer) },
      validation: { trusted: true, revocation: 'good' },
      canPlace: false,
    })
    const target = row?.target as { fileId: string; versionId: string; signedKey: string }
    expect(signature.signedFileId).toBe(target.fileId)
    const [version] = await db()
      .select({ signedCopy: documentVersions.signedCopyFileId })
      .from(documentVersions)
      .where(eq(documentVersions.id, row?.versionId ?? ''))
    expect(version?.signedCopy).toBe(target.fileId)
    const [file] = await db()
      .select({ storageKey: files.storageKey, size: files.size })
      .from(files)
      .where(eq(files.id, target.fileId))
    expect(file).toMatchObject({ storageKey: target.signedKey, size: 92_345 })

    const card = await call(fx.app, { url: `/documents/${doc.id}`, as: people.author })
    expect(card.json().status).toBe('signed')
    expect(await myQualifiedStep(people.boss, instanceId)).toBeUndefined()

    const verify = await call(fx.app, {
      url: `/verify/${signature.id}`,
      headers: { 'accept-language': 'ru' },
    })
    expect(verify.statusCode).toBe(200)
    expect(verify.body).toContain('Квалифицированная электронная подпись')
    expect(verify.body).toContain('Саидзода Тахир Раҳимович')
    const serial = new X509Certificate(ca.signerDer).serialNumber.replace(/^0+/, '').toUpperCase()
    expect(verify.body).toContain(serial)
    expect(signature.certificate.serial).toBe(serial.toLowerCase())

    const audit = await db()
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, doc.id), eq(auditLog.action, 'document.qes_finished')))
    // Прерванный новым, недоверенный, чужой сертификат, отозванный — и подписанный
    const outcomes = audit.map((item) => {
      const details = item.details as { state: string; reason: string | null }
      return details.reason ?? details.state
    })
    expect(outcomes.sort()).toEqual([
      'certificate_mismatch',
      'invalid',
      'signed',
      'superseded',
      'untrusted',
    ])
    // Неудавшийся сеанс так и остался неудавшимся
    const [failed] = await db()
      .select({ state: documentQesSessions.state })
      .from(documentQesSessions)
      .where(eq(documentQesSessions.id, failedSessionId))
    expect(failed?.state).toBe('failed')
  })

  it('повторная проверка: отзыв, найденный позже, виден в подписи и на странице проверки', async () => {
    const [signature] = await signaturesOf(doc.id)
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/signatures/${signature.id}/verify`,
      as: fx.users.stranger,
    })
    expect([403, 404]).toContain(stranger.statusCode)
    const queued = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/signatures/${signature.id}/verify`,
      as: people.author,
    })
    expect(queued.statusCode, queued.body).toBe(200)
    const [session] = await db()
      .select({ id: documentQesSessions.id })
      .from(documentQesSessions)
      .where(eq(documentQesSessions.signatureId, signature.id))
    const plan = await engine(sessionPath(session?.id ?? '', 'start'), { step: 'verify' })
    expect(plan.json()).toMatchObject({ status: 'verify', fieldName: `kchs-${signature.id}` })
    const done = await engine(sessionPath(session?.id ?? '', 'done'), {
      step: 'verify',
      status: 'ready',
      certificate: certificateReport(ca.signerDer),
      validation: validation({ revocation: 'revoked', trusted: false, problem: 'отозван' }),
    })
    expect(done.json()).toEqual({ ok: true, stale: false })
    const [after] = await signaturesOf(doc.id)
    expect(after.validation).toMatchObject({ revocation: 'revoked', trusted: false })
    const verify = await call(fx.app, { url: `/verify/${signature.id}` })
    expect(verify.body).toContain('Квалифицированная подпись не прошла проверку')
  })
})

describe('несколько подписантов', () => {
  it('по очереди: второй подписывает экземпляр первого — новая версия того же файла', async () => {
    const doc = await memoWithPdf()
    const started = await startRoute(doc.id, `qes_two_${run}`)
    expect(started.statusCode, started.body).toBe(200)
    const instanceId = started.json().id as string

    const first = (
      await startSession(
        people.boss,
        doc.id,
        (
          await myQualifiedStep(people.boss, instanceId)
        ).stepId,
      )
    ).json()
    await toVerifying(first)
    const firstRow = await attachDone(first.id, {
      status: 'ready',
      size: 1000,
      sha256: sha256(Buffer.from('first')),
      certificate: certificateReport(ca.signerDer),
      validation: validation(),
    })
    expect(firstRow?.state).toBe('signed')
    const firstTarget = firstRow?.target as { fileId: string; signedKey: string }

    const step = await myQualifiedStep(people.signer, instanceId)
    expect(step).toBeTruthy()
    const second = (await startSession(people.signer, doc.id, step.stepId)).json()
    const { plan } = await toVerifying(second, ca.otherDer)
    // Источник второй подписи — экземпляр с первой КЭП
    expect(plan.source.storageKey).toBe(firstTarget.signedKey)
    const secondRow = await attachDone(second.id, {
      status: 'ready',
      size: 2000,
      sha256: sha256(Buffer.from('second')),
      certificate: certificateReport(ca.otherDer, 'Посторонний Сертификат'),
      validation: validation(),
    })
    expect(secondRow?.state).toBe('signed')
    const secondTarget = secondRow?.target as { fileId: string; mode: string }
    expect(secondTarget).toMatchObject({ fileId: firstTarget.fileId, mode: 'version' })
    const versions = await db()
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(eq(fileVersions.fileId, firstTarget.fileId))
    expect(versions).toHaveLength(2)
    expect((await signaturesOf(doc.id)).map((item) => item.kind)).toEqual([
      'qualified',
      'qualified',
    ])
    const card = await call(fx.app, { url: `/documents/${doc.id}`, as: people.author })
    expect(card.json().status).toBe('signed')
  })

  it('параллельно: пока один подписывает версию, второй ждёт', async () => {
    const doc = await memoWithPdf()
    const started = await startRoute(doc.id, `qes_par_${run}`)
    expect(started.statusCode, started.body).toBe(200)
    const instanceId = started.json().id as string
    const bossStep = await myQualifiedStep(people.boss, instanceId)
    const signerStep = await myQualifiedStep(people.signer, instanceId)
    const boss = await startSession(people.boss, doc.id, bossStep.stepId)
    expect(boss.statusCode, boss.body).toBe(200)
    const busy = await startSession(people.signer, doc.id, signerStep.stepId)
    expect(busy.statusCode, busy.body).toBe(409)
    expect(busy.json().detail).toMatch(/другой участник/)
    // Новый сеанс того же подписанта закрывает прежний
    const again = await startSession(people.boss, doc.id, bossStep.stepId)
    expect(again.statusCode, again.body).toBe(200)
    const [old] = await db()
      .select({ state: documentQesSessions.state, reason: documentQesSessions.reason })
      .from(documentQesSessions)
      .where(eq(documentQesSessions.id, boss.json().id))
    expect(old).toMatchObject({ state: 'failed', reason: 'superseded' })
  })
})

describe('сбой задания движка', () => {
  it('отчёт подготовки о сбое — сеанс не удался, а не висит «готовится»', async () => {
    const doc = await memoWithPdf()
    const started = await startRoute(doc.id, `qes_one_${run}`)
    const step = await myQualifiedStep(people.boss, started.json().id)
    const session = (await startSession(people.boss, doc.id, step.stepId)).json()
    const ticket = ticketOf(session.signingUrl)
    await page('POST', session.id, 'certificate', ticket, {
      certificate: ca.signerDer.toString('base64'),
    })
    const done = await engine(sessionPath(session.id, 'done'), {
      step: 'prepare',
      status: 'failed',
      reason: 'engine_failed',
      error: 'PdfReadError: битый PDF',
    })
    expect(done.json()).toEqual({ ok: true, stale: false })
    const state = await page('GET', session.id, 'state', ticket)
    expect(state.json()).toMatchObject({ state: 'failed', reason: 'engine_failed' })
    // Старт шага по закрытому сеансу — пропуск, а не план
    const skip = await engine(sessionPath(session.id, 'start'), { step: 'prepare' })
    expect(skip.json()).toMatchObject({ status: 'skip' })
    const [signature] = await db()
      .select({ id: documentSignatures.id })
      .from(documentSignatures)
      .where(eq(documentSignatures.documentId, doc.id))
    expect(signature).toBeUndefined()
  })
})
