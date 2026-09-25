import { type APIRequestContext, request as playwrightRequest } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'
import { ACCOUNTS } from './global-setup.js'

/**
 * Готовый отчёт после отправки ответа (N22, ADR-0136): руководитель поручает администратору
 * подготовить ответ; администратор готовит исходящий «в ответ на», регистрирует и отмечает
 * отправку — в карточке поручения появляется «Готовый отчёт» с номером исходящего, «Отправить
 * отчёт» уходит одной кнопкой, автор резолюции принимает отчёт, входящее исполнено.
 */

const MANAGER_LOGIN = 'user001'

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/api/v1/me')
  expect(me.ok(), 'сессия действительна').toBeTruthy()
  return { 'x-csrf-token': (await me.json()).session.csrfToken as string }
}

async function personId(request: APIRequestContext, login: string): Promise<string> {
  const users = await request.get(`/api/v1/users?q=${login}`)
  const found = ((await users.json()).items as Array<{ id: string; login: string }>).find(
    (user) => user.login === login,
  )
  expect(found, `сотрудник ${login}`).toBeTruthy()
  return found?.id as string
}

async function ok(response: { ok(): boolean; text(): Promise<string>; json(): Promise<Json> }) {
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

/** Зарегистрированное входящее со сканом (делопроизводитель — администратор). */
async function registeredIncoming(
  request: APIRequestContext,
  headers: Record<string, string>,
  subject: string,
  run: string,
): Promise<{ id: string; correspondentId: string }> {
  let found = await request.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
  if (((await found.json()).items ?? []).length === 0) {
    await ok(
      await request.post('/api/v1/correspondents', {
        headers,
        data: {
          name: 'Министерство финансов Республики Таджикистан',
          details: { shortName: 'Минфин' },
        },
      }),
    )
    found = await request.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
  }
  const correspondentId = (await found.json()).items[0].id as string
  const types = (await (await request.get('/api/v1/document-types')).json()).items as Json[]
  const typeId = types.find((type) => type.key === 'incoming_letter')?.id
  const draft = await ok(
    await request.post('/api/v1/documents', {
      headers,
      data: {
        typeId,
        subject,
        correspondentId,
        receivedDate: new Date().toISOString().slice(0, 10),
        externalNumber: `14-${run}`,
        deliveryMethod: 'post',
      },
    }),
  )
  const spaceId = (await (await request.get(`/api/v1/documents/${draft.id}`)).json()).spaceId
  const scan = `%PDF-1.4 скан входящего письма ${run}\n`
  const upload = await ok(
    await request.post('/api/v1/files/upload-sessions', {
      headers,
      data: {
        name: `скан-${run}.pdf`,
        size: Buffer.byteLength(scan),
        mime: 'application/pdf',
        spaceId,
        attachToObjectId: draft.id,
      },
    }),
  )
  const put = await request.put(upload.singlePutUrl, {
    data: scan,
    headers: { 'content-type': 'application/pdf' },
  })
  expect(put.ok(), await put.text()).toBeTruthy()
  await ok(
    await request.post(`/api/v1/files/upload-sessions/${upload.uploadId}/complete`, {
      headers,
      data: { uploadId: upload.uploadId, storageKey: upload.storageKey, parts: [] },
    }),
  )
  await ok(
    await request.post(`/api/v1/documents/${draft.id}/versions`, {
      headers,
      data: { mainFileId: upload.fileId },
    }),
  )
  await ok(await request.post(`/api/v1/documents/${draft.id}/register`, { headers, data: {} }))
  return { id: draft.id as string, correspondentId }
}

test.describe('Документы: готовый отчёт по поручению после отправки ответа', () => {
  test('ответ отправлен → «Готовый отчёт» с номером исходящего → одна кнопка → автор принимает', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const headers = await csrf(request)
    const managerId = await personId(request, MANAGER_LOGIN)
    const adminId = await personId(request, 'admin')
    const incoming = await registeredIncoming(request, headers, `О запасах топлива ${run}`, run)

    // Руководитель: направление и резолюция — ответственный администратор
    const before = await (await request.get(`/api/v1/documents/${incoming.id}/resolutions`)).json()
    if (!(before.requests as Json[]).some((item) => item.user.id === managerId)) {
      await ok(
        await request.post(`/api/v1/documents/${incoming.id}/resolution-requests`, {
          headers,
          data: { userId: managerId, note: 'Прошу рассмотреть' },
        }),
      )
    }
    const manager = await playwrightRequest.newContext({ baseURL })
    await ok(
      await manager.post('/api/v1/auth/login', {
        data: {
          login: MANAGER_LOGIN,
          password: ACCOUNTS.employee.password,
          rememberDevice: false,
        },
      }),
    )
    const managerHeaders = await csrf(manager)
    const resolved = await ok(
      await manager.post(`/api/v1/documents/${incoming.id}/resolutions`, {
        headers: managerHeaders,
        data: { text: `Подготовить ответ ${run}`, responsibleId: adminId, dueWorkingDays: 5 },
      }),
    )
    const mainId = (resolved.items[0].instructions as Json[]).find((item) => item.parentId === null)
      .id as string
    await ok(await request.post(`/api/v1/tasks/${mainId}/start`, { headers, data: {} }))

    // Исполнитель готовит ответ, канцелярия регистрирует и отмечает отправку
    const reply = await ok(
      await request.post(`/api/v1/documents/${incoming.id}/reply`, { headers, data: {} }),
    )
    const registered = await ok(
      await request.post(`/api/v1/documents/${reply.id}/register`, { headers, data: {} }),
    )
    const outgoingNumber = registered.regNumber as string
    await ok(
      await request.post(`/api/v1/documents/${reply.id}/dispatches`, {
        headers,
        data: {
          correspondentId: incoming.correspondentId,
          method: 'email',
          sentOn: new Date().toISOString().slice(0, 10),
        },
      }),
    )
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/v1/tasks/${mainId}`)).json()).reportDraft?.text ??
            '') as string,
        { timeout: 30_000 },
      )
      .toContain(outgoingNumber)

    // Карточка поручения: готовый отчёт и отправка одной кнопкой
    await openWorkspace(page, request)
    await page.goto(`/o/${mainId}`)
    const ready = page.getByRole('region', { name: 'Готовый отчёт' })
    await expect(ready).toBeVisible({ timeout: 15_000 })
    await expect(ready.getByText(`исх. № ${outgoingNumber}`)).toBeVisible()
    await ready.getByRole('button', { name: 'Отправить отчёт', exact: true }).click()
    await expect(page.getByText('Отчёт отправлен на приёмку')).toBeVisible()
    await expect(ready).toBeHidden()
    await expect(page.getByText('Отчёт на приёмке', { exact: true }).first()).toBeVisible()

    // Автор резолюции принимает отчёт — входящее исполнено
    await ok(
      await manager.post(`/api/v1/tasks/${mainId}/accept`, { headers: managerHeaders, data: {} }),
    )
    await manager.dispose()
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/v1/documents/${incoming.id}`)).json()).status as string,
        { timeout: 30_000 },
      )
      .toBe('executed')
  })
})
