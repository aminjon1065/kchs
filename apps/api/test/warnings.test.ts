import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, sql } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Предупреждения CAP 1.2 (ADR-0202): черновик вручную и из сообщения об опасном
 * явлении, готовность к выпуску, решение уполномоченного лица подписью с кодом,
 * публикация — CAP по схеме OASIS, ленты Atom и RSS без входа с кэшем и лимитом,
 * событие для вебхуков и время доведения в журнале решений; уточнение и отмена
 * цепочкой `references`; отказ возвращает черновик.
 */
registerLifecycle()

const { TerritoryService } = await import('../src/modules/territories/public.js')
const { WarningSettings } = await import('../src/modules/warnings/public.js')
const { warningSubscribers } = await import('../src/modules/warnings/domain/subscribers.js')
const { WARNING_ROUTE } = await import('../src/seed/packs/emergency/warnings.js')
const { ProcessDefinitions } = await import('../src/kernel/process/index.js')
const { GroupService } = await import('../src/kernel/directory/service.js')
const { bumpPrincipalsVersion } = await import('../src/kernel/access/principal-set.js')
const { dispatchEvent } = await import('../src/modules/integrations/domain/webhook-delivery.js')
const { systemCtx } = await import('../src/shared/context.js')
const { mfaFactors, webhookDeliveries } = await import('../src/db-schema.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

const XSD = fileURLToPath(new URL('./fixtures/cap/CAP-v1.2.xsd', import.meta.url))
const hasXmllint = spawnSync('xmllint', ['--version']).status === 0
const workdir = mkdtempSync(path.join(tmpdir(), 'kchs-warnings-'))

const run = Date.now().toString(36)
let fx: TestContext
let signer: TestUser
let outsider: TestUser
let signerSecret = ''
let datasetId = ''
let rowId = ''
let territoryId = ''

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

afterAll(() => rmSync(workdir, { recursive: true, force: true }))

function validate(xml: string): { ok: boolean; output: string } {
  const file = path.join(workdir, `cap-${Math.random().toString(36).slice(2)}.xml`)
  writeFileSync(file, xml)
  const result = spawnSync('xmllint', ['--noout', '--schema', XSD, file], { encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

/**
 * Код второго фактора подписывающего. Повтор кода того же окна TOTP сервер
 * отклоняет, а подписей в файле больше, чем окон в допуске: перед каждой отметка
 * последнего окна снимается — как если бы прошло полминуты.
 */
async function signCode(): Promise<string> {
  if (!signerSecret) {
    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: signer })
    signerSecret = setup.json().secret as string
    const enable = await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: signer,
      payload: { code: authenticator.generate(signerSecret) },
    })
    expect(enable.statusCode, enable.body).toBe(200)
  }
  await db().update(mfaFactors).set({ lastStep: null }).where(eq(mfaFactors.userId, signer.id))
  return authenticator.generate(signerSecret)
}

const INFO = {
  tg: {
    event: 'Сел',
    headline: 'Огоҳинома: сел дар ВМКБ',
    description: 'Дар водиҳо сел интизор аст',
    instruction: 'Ба роҳ набароед',
  },
  ru: {
    event: 'Сель',
    headline: 'Предупреждение: сель в ГБАО <срочно>',
    description: 'В долинах ожидается сход селей & размыв дорог',
    instruction: 'Не выезжайте на трассу',
  },
  en: {
    event: 'Mudflow',
    headline: 'Warning: mudflow in GBAO',
    description: 'Mudflows are expected in the valleys',
    instruction: 'Do not travel',
  },
}

async function getWarning(as: TestUser, id: string): Promise<Body> {
  const response = await call(fx.app, { url: `/warnings/${id}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** Готовый черновик: все языки, область, срок, подписывающий из группы. */
async function readyDraft(extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/warnings',
    as: fx.users.member,
    payload: {
      info: INFO,
      categories: ['Geo'],
      severity: 'Severe',
      urgency: 'Expected',
      certainty: 'Likely',
      responseTypes: ['Prepare'],
      expires: new Date(Date.now() + 12 * 3600_000).toISOString(),
      areas: [
        { territoryId },
        {
          description: 'Долина Бартанга',
          polygon: [
            [71.9, 38.0],
            [72.4, 38.0],
            [72.4, 38.4],
          ],
        },
      ],
      signerId: signer.id,
      ...extra,
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

async function submit(id: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/warnings/${id}/submit`,
    as: fx.users.member,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().processId as string
}

/** Решение подписывающего по маршруту выпуска. */
async function decide(processId: string, action: 'sign' | 'refuse') {
  const view = await call(fx.app, { url: `/processes/${processId}`, as: signer })
  expect(view.statusCode, view.body).toBe(200)
  const step = view.json().myActions[0]
  expect(step, view.body).toBeTruthy()
  return call(fx.app, {
    method: 'POST',
    url: `/processes/${processId}/steps/${step.stepId}/act`,
    as: signer,
    payload:
      action === 'sign' ? { action, code: await signCode() } : { action, comment: 'Нет оснований' },
  })
}

async function publish(id: string): Promise<void> {
  const processId = await submit(id)
  const signed = await decide(processId, 'sign')
  expect(signed.statusCode, signed.body).toBe(200)
}

async function outboxEvents(type: string, objectId: string): Promise<Body[]> {
  const rows = await db().execute<{ event: Body }>(
    sql`SELECT event FROM ops.outbox WHERE event->>'type' = ${type}
         AND event->'object'->>'id' = ${objectId} ORDER BY id`,
  )
  return rows.map((row) => row.event)
}

beforeAll(async () => {
  fx = await setupFixture()
  signer = await createUser(fx.app, `hq_signer_${run}`, ['employee'], fx.unitId)
  outsider = await createUser(fx.app, `not_hq_${run}`, ['employee'], fx.unitId)
  const ctx = systemCtx('test')
  await db().transaction((tx) => TerritoryService.load(tx, ctx, TERRITORIES as never))
  await TerritoryService.invalidate()
  territoryId = (await TerritoryService.list()).find((item) => item.code === 'TJ-GB')?.id as string

  // Реестр сообщений — как «Сообщения об опасных явлениях» пакета ЧС
  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Сообщения ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'title', label: { ru: 'Сообщение' }, type: 'text', semantic: 'text' },
        {
          key: 'hazard',
          label: { ru: 'Явление' },
          type: 'select',
          semantic: 'category',
          options: [{ value: 'mudflow', label: { ru: 'Сель' } }],
        },
        {
          key: 'alert_level',
          label: { ru: 'Уровень тревоги' },
          type: 'select',
          semantic: 'category',
          options: [{ value: 'orange', label: { ru: 'Оранжевый' } }],
        },
        { key: 'occurred_at', label: { ru: 'Время' }, type: 'datetime', semantic: 'time' },
        { key: 'territory', label: { ru: 'Район' }, type: 'territory', semantic: 'territory' },
        { key: 'published_at', label: { ru: 'Доведено' }, type: 'datetime', semantic: 'time' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        {
          values: {
            code: `MSG-${run}`,
            title: 'Сход селя на трассе Душанбе — Хорог',
            hazard: 'mudflow',
            alert_level: 'orange',
            occurred_at: new Date(Date.now() - 3600_000).toISOString(),
            territory: 'TJ-GB',
          },
        },
      ],
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  rowId = inserted.json().items[0]._id

  // Руководство штаба — группа подписывающих; маршрут выпуска пакета
  const groupId = await db().transaction(async (tx) => {
    const id = await GroupService.create(
      tx,
      ctx,
      `Руководство ${run}`,
      'Подписывают предупреждения',
    )
    await GroupService.setMembers(tx, ctx, id, [signer.id])
    return id
  })
  await bumpPrincipalsVersion()
  await db().transaction((tx) => ProcessDefinitions.ensure(tx, ctx, WARNING_ROUTE))
  await db().transaction((tx) =>
    WarningSettings.ensure(tx, ctx, {
      spaceId: fx.spaceId,
      sourceDatasetId: datasetId,
      signerGroupId: groupId,
    }),
  )
})

describe('черновик', () => {
  it('из сообщения: явление, район, строгость по уровню тревоги, срок — сутки', async () => {
    const sources = await call(fx.app, { url: '/warnings/sources', as: fx.users.member })
    expect(sources.statusCode, sources.body).toBe(200)
    expect(sources.json()).toMatchObject({
      datasetId,
      items: [{ rowId, code: `MSG-${run}`, hazard: 'Сель', territoryName: expect.any(String) }],
    })

    const created = await call(fx.app, {
      method: 'POST',
      url: '/warnings/from-message',
      as: fx.users.member,
      payload: { rowId },
    })
    expect(created.statusCode, created.body).toBe(200)
    const warning = await getWarning(fx.users.member, created.json().id)
    expect(warning).toMatchObject({
      status: 'draft',
      msgType: 'Alert',
      categories: ['Geo'],
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      source: { datasetId, rowId, title: 'Сход селя на трассе Душанбе — Хорог' },
      areas: [{ territoryId, territoryCode: 'TJ-GB' }],
      canEdit: true,
      capUrl: null,
    })
    expect(warning.info.ru.event).toBe('Сель')
    expect(warning.info.tg.event).toBe('Сел')
    expect(warning.identifier).toBe(`urn:uuid:${warning.id}`)
    const hours = (new Date(warning.expires).getTime() - Date.now()) / 3600_000
    expect(hours).toBeGreaterThan(23)

    // Посторонний не видит ни предупреждения, ни сообщений
    const hidden = await call(fx.app, { url: `/warnings/${warning.id}`, as: fx.users.stranger })
    expect(hidden.statusCode).toBe(404)
    const list = await call(fx.app, { url: '/warnings', as: fx.users.stranger })
    expect(list.json().items.map((item: Body) => item.id)).not.toContain(warning.id)
  })

  it('на решение — только готовое: языки, область, срок и уполномоченный подписывающий', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/warnings',
      as: fx.users.member,
      payload: { info: { ru: { headline: 'Проверка' } } },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id
    const early = await call(fx.app, {
      method: 'POST',
      url: `/warnings/${id}/submit`,
      as: fx.users.member,
    })
    expect(early.statusCode).toBe(400)
    const paths = early.json().errors.map((issue: Body) => issue.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'info.tg.headline',
        'info.ru.description',
        'categories',
        'areas',
        'expires',
        'signerId',
      ]),
    )

    const patched = await call(fx.app, {
      method: 'PUT',
      url: `/warnings/${id}`,
      as: fx.users.member,
      payload: {
        info: INFO,
        categories: ['Met'],
        areas: [{ territoryId }],
        expires: new Date(Date.now() + 3600_000).toISOString(),
        signerId: outsider.id,
      },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json().title).toBe(INFO.ru.headline)
    const wrongSigner = await call(fx.app, {
      method: 'POST',
      url: `/warnings/${id}/submit`,
      as: fx.users.member,
    })
    expect(wrongSigner.statusCode).toBe(400)
    expect(wrongSigner.json().errors).toEqual([expect.objectContaining({ path: 'signerId' })])

    // Читатель пространства не правит и не отправляет
    const viewer = await call(fx.app, {
      method: 'PUT',
      url: `/warnings/${id}`,
      as: fx.users.viewer,
      payload: { severity: 'Minor' },
    })
    expect(viewer.statusCode).toBe(403)
  })
})

describe('выпуск', () => {
  let published = ''

  it('подпись с кодом публикует: CAP по схеме, событие, ленты без входа', async () => {
    published = await readyDraft({ source: { datasetId, rowId } })
    const processId = await submit(published)
    const pending = await getWarning(fx.users.member, published)
    expect(pending).toMatchObject({ status: 'on_approval', processId, canEdit: false })
    expect(await outboxEvents('warning.submitted', published)).toHaveLength(1)
    // На утверждении содержание не меняется
    const frozen = await call(fx.app, {
      method: 'PUT',
      url: `/warnings/${published}`,
      as: fx.users.member,
      payload: { severity: 'Minor' },
    })
    expect(frozen.statusCode).toBe(409)
    // Подписывающий видит предупреждение как участник маршрута
    expect((await call(fx.app, { url: `/warnings/${published}`, as: signer })).statusCode).toBe(200)

    // Без кода подпись не проходит
    const view = (await call(fx.app, { url: `/processes/${processId}`, as: signer })).json()
    const noCode = await call(fx.app, {
      method: 'POST',
      url: `/processes/${processId}/steps/${view.myActions[0].stepId}/act`,
      as: signer,
      payload: { action: 'sign' },
    })
    expect(noCode.statusCode).not.toBe(200)
    expect((await getWarning(fx.users.member, published)).status).toBe('on_approval')

    const signed = await decide(processId, 'sign')
    expect(signed.statusCode, signed.body).toBe(200)
    const warning = await getWarning(fx.users.member, published)
    expect(warning).toMatchObject({
      status: 'published',
      approvedBy: { id: signer.id },
      capUrl: expect.stringContaining(`/api/v1/public/cap/${published}.xml`),
      canSupersede: true,
    })
    expect(warning.publishedAt).toBeTruthy()

    const [event] = await outboxEvents('warning.published', published)
    expect(event.payload).toMatchObject({
      identifier: `urn:uuid:${published}`,
      msgType: 'Alert',
      references: null,
      sourceDatasetId: datasetId,
      sourceRowId: rowId,
      headline: INFO.ru.headline,
    })

    // CAP — без входа, по схеме OASIS, с кэшем и ETag
    const cap = await call(fx.app, { url: `/public/cap/${published}.xml` })
    expect(cap.statusCode, cap.body).toBe(200)
    expect(cap.headers['content-type']).toContain('application/cap+xml')
    expect(cap.headers['cache-control']).toBe('public, max-age=60')
    expect(cap.body).toContain(`<identifier>urn:uuid:${published}</identifier>`)
    expect(cap.body).toContain('<language>tg-TJ</language>')
    expect(cap.body).toContain('<value>TJ-GB</value>')
    expect(cap.body).toContain('&lt;срочно&gt;')
    expect(cap.body).toContain('<polygon>38,71.9 38,72.4 38.4,72.4 38,71.9</polygon>')
    if (hasXmllint) {
      const result = validate(cap.body)
      expect(result.ok, result.output).toBe(true)
    }
    const again = await call(fx.app, {
      url: `/public/cap/${published}.xml`,
      headers: { 'if-none-match': cap.headers.etag as string },
    })
    expect(again.statusCode).toBe(304)

    const atom = await call(fx.app, { url: '/public/cap/feed.xml' })
    expect(atom.statusCode).toBe(200)
    expect(atom.headers['content-type']).toContain('application/atom+xml')
    expect(atom.body).toContain(`<id>urn:uuid:${published}</id>`)
    const rss = await call(fx.app, { url: '/public/cap/rss/tg.xml' })
    expect(rss.statusCode).toBe(200)
    expect(rss.body).toContain(INFO.tg.headline)
    expect((await call(fx.app, { url: '/public/cap/rss/de.xml' })).statusCode).toBe(400)
  })

  it('черновик и чужой адрес наружу не видны', async () => {
    const draft = await readyDraft()
    expect((await call(fx.app, { url: `/public/cap/${draft}.xml` })).statusCode).toBe(404)
    const unknown = '00000000-0000-4000-8000-000000000000'
    expect((await call(fx.app, { url: `/public/cap/${unknown}.xml` })).statusCode).toBe(404)
    const atom = await call(fx.app, { url: '/public/cap/feed.xml' })
    expect(atom.body).not.toContain(draft)
  })

  it('журнал решений: время доведения у сообщения ставится один раз', async () => {
    const [event] = await outboxEvents('warning.published', published)
    const handler = warningSubscribers[0]
    if (!handler) throw new Error('нет подписчика журнала решений')
    await handler.handle(event)
    const row = await call(fx.app, { url: `/datasets/${datasetId}/rows/${rowId}`, as: fx.admin })
    expect(row.statusCode, row.body).toBe(200)
    const stamped = row.json().values.published_at
    expect(new Date(stamped).getTime()).toBe(new Date(event.payload.sent).getTime())
    // Повтор и позднее событие время не переписывают
    await handler.handle({
      ...event,
      payload: { ...event.payload, sent: new Date().toISOString() },
    })
    const after = await call(fx.app, { url: `/datasets/${datasetId}/rows/${rowId}`, as: fx.admin })
    expect(after.json().values.published_at).toBe(stamped)
  })

  it('вебхук сайта получает warning.published существующей доставкой', async () => {
    const hook = await call(fx.app, {
      method: 'POST',
      url: '/webhooks',
      as: fx.admin,
      payload: {
        name: `Сайт ${run}`,
        url: 'http://127.0.0.1:9/hook',
        eventTypes: ['warning.published'],
      },
    })
    expect(hook.statusCode, hook.body).toBe(200)
    const webhookId = hook.json().webhook.id
    const [event] = await outboxEvents('warning.published', published)
    await dispatchEvent(event)
    const deliveries = await db()
      .select({ eventType: webhookDeliveries.eventType })
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.eventId, event.id)),
      )
    expect(deliveries).toEqual([{ eventType: 'warning.published' }])
  })

  it('уточнение и отмена — новым предупреждением со ссылкой на прежнее', async () => {
    const update = await call(fx.app, {
      method: 'POST',
      url: `/warnings/${published}/supersede`,
      as: fx.users.member,
      payload: { msgType: 'Update' },
    })
    expect(update.statusCode, update.body).toBe(200)
    const updateId = update.json().id
    // Пока уточнение в работе, второго нет
    const second = await call(fx.app, {
      method: 'POST',
      url: `/warnings/${published}/supersede`,
      as: fx.users.member,
      payload: { msgType: 'Cancel' },
    })
    expect(second.statusCode).toBe(409)
    expect(await getWarning(fx.users.member, updateId)).toMatchObject({
      status: 'draft',
      msgType: 'Update',
      references: { id: published, identifier: `urn:uuid:${published}` },
      info: { ru: { headline: INFO.ru.headline } },
    })

    await publish(updateId)
    expect(await getWarning(fx.users.member, published)).toMatchObject({
      status: 'updated',
      supersededBy: { id: updateId, msgType: 'Update' },
      canSupersede: false,
    })
    const updatedCap = (await call(fx.app, { url: `/public/cap/${updateId}.xml` })).body
    expect(updatedCap).toContain('<msgType>Update</msgType>')
    expect(updatedCap).toMatch(
      new RegExp(`<references>[^<]*,urn:uuid:${published},[^<]*</references>`),
    )
    if (hasXmllint) expect(validate(updatedCap).ok).toBe(true)
    // Прежний CAP остаётся по своему адресу, из ленты уходит
    expect((await call(fx.app, { url: `/public/cap/${published}.xml` })).statusCode).toBe(200)
    const atom = (await call(fx.app, { url: '/public/cap/feed.xml' })).body
    expect(atom).not.toContain(`<id>urn:uuid:${published}</id>`)
    expect(atom).toContain(`<id>urn:uuid:${updateId}</id>`)

    const cancel = await call(fx.app, {
      method: 'POST',
      url: `/warnings/${updateId}/supersede`,
      as: fx.users.member,
      payload: { msgType: 'Cancel' },
    })
    expect(cancel.statusCode, cancel.body).toBe(200)
    const cancelId = cancel.json().id
    const draft = await getWarning(fx.users.member, cancelId)
    expect(draft.info.ru.headline).toBe(`Отмена: ${INFO.ru.headline}`)
    expect(draft.responseTypes).toEqual(['AllClear'])
    await publish(cancelId)
    expect((await getWarning(fx.users.member, updateId)).status).toBe('cancelled')
    const cancelCap = (await call(fx.app, { url: `/public/cap/${cancelId}.xml` })).body
    expect(cancelCap).toContain('<msgType>Cancel</msgType>')
    // Цепочка: и первое, и уточнение
    expect(cancelCap).toContain(`urn:uuid:${published}`)
    expect(cancelCap).toContain(`urn:uuid:${updateId}`)
    if (hasXmllint) expect(validate(cancelCap).ok).toBe(true)
    const superseded = await outboxEvents('warning.superseded', updateId)
    expect(superseded.map((event) => event.payload.status)).toEqual(['cancelled'])

    // Опубликованное не удаляется
    const trash = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${cancelId}`,
      as: fx.admin,
    })
    expect(trash.statusCode).toBe(409)
  })

  it('отказ подписывающего возвращает черновик', async () => {
    const id = await readyDraft()
    const processId = await submit(id)
    const refused = await decide(processId, 'refuse')
    expect(refused.statusCode, refused.body).toBe(200)
    expect(await getWarning(fx.users.member, id)).toMatchObject({
      status: 'draft',
      canSubmit: true,
      publishedAt: null,
    })
    const [returned] = await outboxEvents('warning.returned', id)
    expect(returned.payload.outcome).toBe('refused')
    expect(await outboxEvents('warning.published', id)).toEqual([])
  })
})
