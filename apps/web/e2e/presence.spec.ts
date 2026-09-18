import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

const BASE = 'http://localhost:5173'

/**
 * Присутствие (02-platform-kernel.md §Realtime): двое открыли один файл —
 * каждый видит другого в «Сейчас смотрят»; ушедший пропадает сразу, а не
 * через минуту.
 */
test('присутствие: кто смотрит файл, ушедший исчезает', async ({ page, request, browser }) => {
  const run = Date.now().toString(36)
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }

  // Пространство прогона с сотрудником и файл в нём
  const space = await request.post('/api/v1/spaces', {
    headers,
    data: { key: `presence-${run}`, name: `Присутствие ${run}` },
  })
  expect(space.ok(), await space.text()).toBeTruthy()
  const spaceId = (await space.json()).id as string
  const users = await request.get('/api/v1/users?q=user001')
  const employee = (await users.json()).items[0] as { id: string; displayName: string }
  const joined = await request.post(`/api/v1/spaces/${spaceId}/members`, {
    headers,
    data: { userId: employee.id, role: 'viewer' },
  })
  expect(joined.ok(), await joined.text()).toBeTruthy()

  const content = 'Сводка: уровень воды 412 см\n'
  const session = await request.post('/api/v1/files/upload-sessions', {
    headers,
    data: {
      name: `svodka-${run}.txt`,
      size: Buffer.byteLength(content),
      mime: 'text/plain',
      spaceId,
    },
  })
  expect(session.ok(), await session.text()).toBeTruthy()
  const upload = await session.json()
  const put = await request.put(upload.singlePutUrl, {
    data: content,
    headers: { 'content-type': 'text/plain' },
  })
  expect(put.ok(), await put.text()).toBeTruthy()
  const completed = await request.post(
    `/api/v1/files/upload-sessions/${upload.uploadId}/complete`,
    {
      headers,
      data: { uploadId: upload.uploadId, storageKey: upload.storageKey, parts: [] },
    },
  )
  expect(completed.ok(), await completed.text()).toBeTruthy()
  const fileId = upload.fileId as string

  // Оба открывают файл
  await openWorkspace(page, request)
  await page.goto(`/o/${fileId}`)
  const colleague = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  await resetWorkspaceState(colleague.request)
  const colleaguePage = await colleague.newPage()
  await colleaguePage.goto(`/o/${fileId}`)

  const viewing = (name: string) => ({ name: new RegExp(`Сейчас смотрят: .*${name}`) })
  await expect(page.getByRole('group', viewing(employee.displayName))).toBeVisible({
    timeout: 15_000,
  })
  await expect(colleaguePage.getByRole('group', viewing('Администратор'))).toBeVisible({
    timeout: 15_000,
  })

  // Коллега закрыл страницу — у администратора он пропадает без ожидания срока
  await colleague.close()
  await expect(page.getByRole('group', viewing(employee.displayName))).toHaveCount(0, {
    timeout: 10_000,
  })
})
