import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Интеграции P5-E04: совместное редактирование офисных файлов (ADR-0112) и
 * очередь «Из почты» (ADR-0113).
 *
 * Редактор поднимается отдельным профилем compose
 * (`docker compose --profile office up -d onlyoffice`). Если в установке его
 * нет, сценарий проверяет обратное: кнопки «Открыть в редакторе» не видно, а
 * файл по-прежнему скачивается — «белого экрана» не появляется ни в одном из
 * двух состояний.
 */
test.describe('Офисный редактор и почта канцелярии', () => {
  test('DOCX открывается в редакторе вкладкой рабочей области', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const name = `Приказ ${run}.docx`
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    const me = await request.get('/api/v1/me')
    expect(me.ok(), await me.text()).toBeTruthy()
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }

    // Файл кладём в общее пространство обычным путём клиента: сессия → S3 → подтверждение
    const spaces = await request.get('/api/v1/spaces')
    const spaceId = ((await spaces.json()).items as Array<{ id: string; kind: string }>).find(
      (space) => space.kind !== 'personal',
    )?.id
    expect(spaceId, 'есть непользовательское пространство').toBeTruthy()

    const content = Buffer.from(`PK\u0003\u0004 ${run}`)
    const session = await request.post('/api/v1/files/upload-sessions', {
      headers,
      data: { name, size: content.byteLength, mime, spaceId },
    })
    expect(session.ok(), await session.text()).toBeTruthy()
    const upload = await session.json()
    const put = await request.put(upload.singlePutUrl, {
      data: content,
      headers: { 'content-type': mime },
    })
    expect(put.ok(), await put.text()).toBeTruthy()
    const completed = await request.post(
      `/api/v1/files/upload-sessions/${upload.uploadId}/complete`,
      { headers, data: { uploadId: upload.uploadId, storageKey: upload.storageKey, parts: [] } },
    )
    expect(completed.ok(), await completed.text()).toBeTruthy()
    const fileId = upload.fileId as string

    const status = await request.get('/api/v1/files/office/status')
    expect(status.ok(), await status.text()).toBeTruthy()
    const office = (await status.json()) as { configured: boolean; available: boolean }

    try {
      await openWorkspace(page, request)
      await page.goto(`/o/${fileId}`)
      await expect(page.getByRole('tab', { name: new RegExp(run) })).toBeVisible({
        timeout: 20_000,
      })
      const download = page.getByRole('button', { name: 'Скачать' }).first()
      const open = page.getByRole('button', { name: 'Открыть в редакторе' })

      if (!office.configured) {
        // Редактор не настроен: кнопки нет, файл скачивается обычным путём
        await expect(open).toBeHidden()
        await expect(download).toBeVisible()
        return
      }

      await expect(open).toBeVisible()
      await open.click()

      if (office.available) {
        const editor = page.getByRole('region', { name: 'Редактор' })
        await expect(editor).toBeVisible({ timeout: 30_000 })
        // Правка — режим того, кто файл загрузил; читателю досталcя бы «Просмотр»
        await expect(editor.getByText('Правка')).toBeVisible()
        await expect(page.locator(`iframe[title="${name}"]`)).toHaveAttribute(
          'src',
          /\/api\/v1\/office\/editor\//,
        )
      } else {
        // Сервер документов недоступен: понятное сообщение и загрузка файла
        await expect(page.getByText('Редактор недоступен')).toBeVisible({ timeout: 30_000 })
        await expect(download).toBeVisible()
      }
    } finally {
      await request.delete(`/api/v1/objects/${fileId}`, { headers })
    }
  })

  test('очередь «Из почты» открывается и опрашивает ящики', async ({ page, request }) => {
    test.setTimeout(90_000)
    await openWorkspace(page, request)

    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await expect(page.getByRole('tab', { name: /Документы/ })).toBeVisible()

    await page.getByRole('button', { name: 'Из почты' }).click()
    const screen = page.getByRole('region', { name: 'Из почты' })
    await expect(screen).toBeVisible()

    // Ящик канцелярии на стенде обычно не настроен: очередь пуста и подсказывает,
    // где её завести; с настроенным ящиком — список писем. Считаем то и другое:
    // `or` в строгом режиме падает, когда совпадают обе ветки (заголовок пустого
    // состояния и его пояснение — уже два совпадения)
    const empty = screen.getByText('Писем нет')
    const letters = screen.getByRole('option')
    await expect
      .poll(async () => (await empty.count()) + (await letters.count()), { timeout: 20_000 })
      .toBeGreaterThan(0)

    // «Получить почту» всегда отвечает отчётом: без ящиков — нулевым
    await screen.getByRole('button', { name: 'Получить почту' }).click()
    await expect(page.getByText(/Забрано писем/)).toBeVisible({ timeout: 30_000 })
  })
})
