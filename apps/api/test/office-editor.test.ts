import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { objects } from '../src/shared/db/schema/index.js'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Совместное редактирование офисных файлов (P5-E04, ADR-0112).
 *
 * Сервер документов подменён простым сервером: он отвечает на проверку живости
 * и отдаёт «сохранённый» файл. Всё остальное — наш код: права и режим, страница
 * редактора со своей политикой CSP, пропуска служебных маршрутов и колбэк,
 * который становится новой версией файла.
 */
registerLifecycle()

const SECRET = 'office-test-secret-0123456789'
const EDITED = Buffer.from('PK\u0003\u0004правка из редактора')

let fx: TestContext
let documentServer: Server
let fileId = ''
let sessionId = ''
let signJwt: (payload: Record<string, unknown>, secret: string, ttl?: number) => string
let officeTicket: (session: string, purpose: string, secret: string, ttlMs: number) => string
const previous = { url: process.env.ONLYOFFICE_URL, secret: process.env.ONLYOFFICE_JWT_SECRET }

interface SessionBody {
  id: string
  mode: 'edit' | 'view'
  documentType: string
  editorUrl: string
  versionId: string | null
}

beforeAll(async () => {
  // Сервер документов установки: живость и «скачай правку отсюда»
  documentServer = createServer((request, response) => {
    if (request.url === '/healthcheck') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('true')
      return
    }
    if (request.url?.startsWith('/cache/')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(EDITED)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => documentServer.listen(0, '127.0.0.1', resolve))
  const port = (documentServer.address() as AddressInfo).port

  process.env.ONLYOFFICE_URL = `http://127.0.0.1:${port}`
  process.env.ONLYOFFICE_JWT_SECRET = SECRET
  const { resetConfigCache } = await import('../src/shared/config/env.js')
  resetConfigCache()
  ;({ signJwt, officeTicket } = await import('../src/modules/files/domain/office.js'))

  fx = await setupFixture()
  const file = await uploadFile(fx.app, fx.admin, {
    spaceId: fx.spaceId,
    name: `Приказ ${Date.now().toString(36)}.docx`,
    content: Buffer.from('PK\u0003\u0004исходный документ'),
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  fileId = file.id
})

afterAll(async () => {
  await new Promise<void>((resolve) => documentServer.close(() => resolve()))
  process.env.ONLYOFFICE_URL = previous.url ?? ''
  process.env.ONLYOFFICE_JWT_SECRET = previous.secret ?? ''
  const { resetConfigCache } = await import('../src/shared/config/env.js')
  resetConfigCache()
})

describe('офисный редактор', () => {
  it('редактор доступен установке и знает свои форматы', async () => {
    const status = await call(fx.app, { url: '/files/office/status', as: fx.admin })

    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ configured: true, available: true })
    expect(status.json().formats).toContain('docx')
  })

  it('владелец открывает файл на правку, читатель — на просмотр', async () => {
    const owner = await call(fx.app, {
      method: 'POST',
      url: `/files/${fileId}/office-session`,
      as: fx.admin,
    })
    expect(owner.statusCode).toBe(200)
    const body = owner.json<SessionBody>()
    expect(body.mode).toBe('edit')
    expect(body.documentType).toBe('word')
    expect(body.editorUrl).toBe(`/api/v1/office/editor/${body.id}`)
    sessionId = body.id

    const viewer = await call(fx.app, {
      method: 'POST',
      url: `/files/${fileId}/office-session`,
      as: fx.users.viewer,
    })
    expect(viewer.statusCode).toBe(200)
    expect(viewer.json<SessionBody>().mode).toBe('view')
    // Одна версия — одна сессия: второй читатель входит в ту же
    expect(viewer.json<SessionBody>().id).toBe(sessionId)
  })

  it('посторонний не открывает чужой файл', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/files/${fileId}/office-session`,
      as: fx.users.stranger,
    })
    expect(response.statusCode).toBe(404)
  })

  it('страница редактора несёт свою политику и не открывается постороннему', async () => {
    const page = await call(fx.app, { url: `/api/v1/office/editor/${sessionId}`, as: fx.admin })

    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    const csp = String(page.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(process.env.ONLYOFFICE_URL ?? '')
    // Своё приложение скрипту редактора недоступно: 'self' в connect-src нет
    expect(csp).not.toContain("connect-src 'self'")
    expect(page.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(page.body).toContain('/web-apps/apps/api/documents/api.js')
    expect(page.body).toContain('"callbackUrl"')

    const forViewer = await call(fx.app, {
      url: `/api/v1/office/editor/${sessionId}`,
      as: fx.users.viewer,
    })
    expect(forViewer.statusCode).toBe(200)
    // Читателю адрес сохранения не выдаётся вовсе
    expect(forViewer.body).not.toContain('"callbackUrl"')

    const forStranger = await call(fx.app, {
      url: `/api/v1/office/editor/${sessionId}`,
      as: fx.users.stranger,
    })
    expect(forStranger.statusCode).toBe(404)
  })

  it('содержимое отдаётся только по действительному пропуску', async () => {
    const good = officeTicket(sessionId, 'content', SECRET, 60_000)
    const ok = await call(fx.app, { url: `/internal/office/${sessionId}/content?t=${good}` })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toContain('исходный документ')

    const wrongPurpose = officeTicket(sessionId, 'callback', SECRET, 60_000)
    const denied = await call(fx.app, {
      url: `/internal/office/${sessionId}/content?t=${wrongPurpose}`,
    })
    expect(denied.statusCode).toBe(404)

    const foreign = officeTicket(sessionId, 'content', 'чужой-секрет', 60_000)
    const alien = await call(fx.app, { url: `/internal/office/${sessionId}/content?t=${foreign}` })
    expect(alien.statusCode).toBe(404)
  })

  it('колбэк без подписи не принимается', async () => {
    const ticket = officeTicket(sessionId, 'callback', SECRET, 60_000)
    const response = await call(fx.app, {
      method: 'POST',
      url: `/internal/office/${sessionId}/callback?t=${ticket}`,
      payload: { status: 2, url: `${process.env.ONLYOFFICE_URL}/cache/out.docx` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('«файл сейчас правят»: список сервера документов виден карточкам, постороннему — нет', async () => {
    const callback = async (body: Record<string, unknown>) => {
      const ticket = officeTicket(sessionId, 'callback', SECRET, 60_000)
      const response = await call(fx.app, {
        method: 'POST',
        url: `/internal/office/${sessionId}/callback?t=${ticket}`,
        payload: body,
        headers: { authorization: `Bearer ${signJwt(body, SECRET, 60)}` },
      })
      expect(response.json()).toEqual({ error: 0 })
    }
    const editing = async (as: TestUser) => {
      const response = await call(fx.app, { url: `/files/office/editing?ids=${fileId}`, as })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().items as Array<{ fileId: string; editors: Array<{ id: string }> }>
    }

    expect(await editing(fx.admin)).toEqual([])
    // Сотрудник вошёл в документ: сервер документов шлёт всех, кто в нём сейчас
    await callback({
      key: 'k',
      status: 1,
      users: [fx.admin.id, 'не-идентификатор'],
      actions: [{ type: 1, userid: fx.admin.id }],
    })
    const now = await editing(fx.admin)
    expect(now.map((item) => item.fileId)).toEqual([fileId])
    expect(now[0]?.editors.map((user) => user.id)).toEqual([fx.admin.id])
    expect(await editing(fx.users.viewer)).toHaveLength(1)
    expect(await editing(fx.users.stranger)).toEqual([])

    // Вышел — файл больше не правят
    await callback({ key: 'k', status: 1, users: [], actions: [{ type: 0, userid: fx.admin.id }] })
    expect(await editing(fx.admin)).toEqual([])
  })

  it('сохранение из редактора становится новой версией файла', async () => {
    const before = await call(fx.app, { url: `/files/${fileId}/versions`, as: fx.admin })
    expect(before.json().items).toHaveLength(1)

    const body = {
      key: 'ignored-by-us',
      status: 2,
      url: `${process.env.ONLYOFFICE_URL}/cache/out.docx`,
      users: ['someone'],
    }
    const ticket = officeTicket(sessionId, 'callback', SECRET, 60_000)
    const saved = await call(fx.app, {
      method: 'POST',
      url: `/internal/office/${sessionId}/callback?t=${ticket}`,
      payload: body,
      headers: { authorization: `Bearer ${signJwt(body, SECRET, 60)}` },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ error: 0 })

    const after = await call(fx.app, { url: `/files/${fileId}/versions`, as: fx.admin })
    const versions = after.json().items as Array<{ number: number; note: string | null }>
    expect(versions).toHaveLength(2)
    expect(versions[0]?.number).toBe(2)
    expect(versions[0]?.note).toContain('Совместное редактирование')

    // Содержимое новой версии — то, что отдал сервер документов
    const download = await call(fx.app, { url: `/files/${fileId}/download`, as: fx.admin })
    const stored = await fetch(download.json().url)
    expect(Buffer.from(await stored.arrayBuffer()).toString()).toBe(EDITED.toString())
  })

  it('после сохранения открывается новая сессия: ключ документа привязан к версии', async () => {
    const next = await call(fx.app, {
      method: 'POST',
      url: `/files/${fileId}/office-session`,
      as: fx.admin,
    })
    expect(next.statusCode).toBe(200)
    expect(next.json<SessionBody>().id).not.toBe(sessionId)
  })

  it('файл с грифом во внешний редактор не отдаётся', async () => {
    // Допуск владельцу: иначе он не увидел бы файл вовсе и проверка грифа
    // редактора осталась бы за 404 (ADR-0080)
    const cleared = await call(fx.app, {
      method: 'PUT',
      url: `/users/${fx.admin.id}/clearance`,
      as: fx.admin,
      payload: { clearance: 'confidential', reason: 'Допуск по приказу о режиме секретности' },
    })
    expect(cleared.statusCode, cleared.body).toBe(200)

    const graded = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `Смета ${Date.now().toString(36)}.xlsx`,
      content: Buffer.from('PK\u0003\u0004смета'),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    await db()
      .update(objects)
      .set({ confidentiality: 'confidential' })
      .where(eq(objects.id, graded.id))

    const response = await call(fx.app, {
      method: 'POST',
      url: `/files/${graded.id}/office-session`,
      as: fx.admin,
    })
    expect(response.statusCode, response.body).toBe(403)
    expect(response.json().data?.reason).toBe('office_confidential')
  })

  it('гриф, поднятый при открытой сессии, закрывает и страницу, и содержимое', async () => {
    // Сессия живёт 12 часов, а гриф ставят позже открытия. Проверка только при
    // открытии оставляла бы исходник доступным по уже выданному пропуску
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `Справка ${Date.now().toString(36)}.docx`,
      content: Buffer.from('PK\u0003\u0004справка'),
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const opened = await call(fx.app, {
      method: 'POST',
      url: `/files/${file.id}/office-session`,
      as: fx.admin,
    })
    expect(opened.statusCode, opened.body).toBe(200)
    const id = opened.json<SessionBody>().id
    const ticket = officeTicket(id, 'content', SECRET, 60_000)
    expect((await call(fx.app, { url: `/internal/office/${id}/content?t=${ticket}` })).statusCode) //
      .toBe(200)

    await db()
      .update(objects)
      .set({ confidentiality: 'confidential' })
      .where(eq(objects.id, file.id))

    const content = await call(fx.app, { url: `/internal/office/${id}/content?t=${ticket}` })
    expect(content.statusCode).toBe(404)
    const page = await call(fx.app, { url: `/api/v1/office/editor/${id}`, as: fx.admin })
    expect(page.statusCode).toBe(404)
  })
})
