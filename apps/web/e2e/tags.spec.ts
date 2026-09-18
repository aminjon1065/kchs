import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Теги в контекстной панели (02-platform-kernel.md §14): назначение с
 * созданием в словаре, подсказка при повторном вводе, поиск по тегу, снятие.
 */
test.describe('Теги объекта', () => {
  test('назначить, найти по тегу и снять', async ({ page, request }) => {
    await openWorkspace(page, request)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = await request.get('/api/v1/spaces')
    const spaceId = (await spaces.json()).items.find(
      (space: { kind: string }) => space.kind !== 'personal',
    ).id

    const run = Date.now().toString(36)
    const title = `Сводка без ключевых слов ${run}`
    const tag = `оползень${run}`
    const folder = await request.post('/api/v1/folders', {
      headers,
      data: { name: title, spaceId },
    })
    expect(folder.ok()).toBeTruthy()
    const folderId = (await folder.json()).id as string

    // Ссылка на объект открывает вкладку, панель «Инфо» показывает теги
    await page.goto(`/o/${folderId}`)
    await expect(page.getByRole('tab', { name: new RegExp(title) })).toBeVisible()
    const input = page.getByRole('combobox', { name: 'Теги' })
    await expect(input).toBeVisible()

    await input.fill(tag)
    await expect(page.getByRole('option', { name: `Создать тег «${tag}»` })).toBeVisible()
    await input.press('Enter')
    const remove = page.getByRole('button', { name: `Убрать тег «${tag}»` })
    await expect(remove).toBeVisible()
    await expect(input).toHaveValue('')

    // Второй объект: тот же тег приходит подсказкой из словаря пространства
    const other = await request.post('/api/v1/folders', {
      headers,
      data: { name: `Вторая папка ${run}`, spaceId },
    })
    await page.goto(`/o/${(await other.json()).id}`)
    const otherInput = page.getByRole('combobox', { name: 'Теги' })
    await otherInput.fill(tag.slice(0, 6))
    await expect(page.getByRole('option', { name: tag, exact: true })).toBeVisible()
    await otherInput.press('Escape')

    // Поиск находит папку по тегу, которого нет в названии
    await expect
      .poll(
        async () => {
          const found = await request.get(`/api/v1/search?q=${encodeURIComponent(tag)}`)
          return ((await found.json()).hits as Array<{ objectId: string }>).map((h) => h.objectId)
        },
        { timeout: 15_000 },
      )
      .toContain(folderId)

    // Снятие тега переживает перезагрузку
    await page.goto(`/o/${folderId}`)
    await page.getByRole('button', { name: `Убрать тег «${tag}»` }).click()
    await expect(page.getByRole('button', { name: `Убрать тег «${tag}»` })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Теги' })).toBeVisible()
    await expect(page.getByRole('button', { name: `Убрать тег «${tag}»` })).toHaveCount(0)
  })
})
