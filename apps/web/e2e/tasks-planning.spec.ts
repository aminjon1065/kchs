import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures.js'

/**
 * Планирование задач (ADR-0155, ADR-0156): чек-лист и подзадача в карточке, таймлайн
 * (срок с клавиатуры), массовое «Закрыть» в списке, пауза серии повторяющихся задач.
 */
async function prepare(request: APIRequestContext) {
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
    kind: string
  }>
  const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id
  const users = (await (await request.get('/api/v1/users?q=admin')).json()).items as Array<{
    id: string
    login: string
  }>
  const adminId = users.find((user) => user.login === 'admin')?.id
  expect(adminId).toBeTruthy()
  const createTask = async (title: string, extra: Record<string, unknown> = {}) => {
    const created = await request.post('/api/v1/tasks', {
      headers,
      data: { kind: 'task', title, spaceId, assigneeId: adminId, ...extra },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    return (await created.json()).id as string
  }
  return { headers, spaceId, createTask }
}

const localDay = (iso: string) => new Date(iso).toLocaleDateString('sv')

test.describe('Задачи: чек-лист, таймлайн, массовые действия, серии', () => {
  test('чек-лист и подзадача в карточке задачи', async ({ page, request }) => {
    const run = Date.now().toString(36)
    const { createTask } = await prepare(request)
    const id = await createTask(`План учения ${run}`)

    await page.goto(`/o/${id}`)
    const step = page.getByRole('textbox', { name: 'Добавить пункт' })
    await step.fill(`Собрать сводку ${run}`)
    await step.press('Enter')
    const item = page.getByRole('checkbox', { name: `Собрать сводку ${run}` })
    await expect(item).not.toBeChecked()
    await item.click()
    await expect(item).toBeChecked()

    const subtask = page.getByRole('textbox', { name: 'Добавить подзадачу' })
    await subtask.fill(`Согласовать маршрут ${run}`)
    await subtask.press('Enter')
    await expect(
      page.getByRole('list', { name: 'Подзадачи' }).getByText(`Согласовать маршрут ${run}`),
    ).toBeVisible()

    const record = await (await request.get(`/api/v1/tasks/${id}`)).json()
    expect(record.checklistProgress).toEqual({ done: 1, total: 1 })
    expect(record.subtaskProgress).toEqual({ done: 0, total: 1 })
  })

  test('таймлайн: Shift и стрелка переносят срок на день', async ({ page, request }) => {
    const run = Date.now().toString(36)
    const { createTask } = await prepare(request)
    const title = `Полоса ${run}`
    const id = await createTask(title, {
      dueAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    })
    const before = (await (await request.get(`/api/v1/tasks/${id}`)).json()).dueAt as string

    await page.goto('/tasks')
    await page.getByRole('radio', { name: /Таймлайн/ }).click()
    const bar = page
      .getByRole('region', { name: /Таймлайн/ })
      .getByRole('button', { name: new RegExp(`^${title}: с `) })
    await bar.focus()
    await page.keyboard.press('Shift+ArrowRight')

    const expected = new Date(before)
    expected.setDate(expected.getDate() + 1)
    await expect
      .poll(async () => localDay((await (await request.get(`/api/v1/tasks/${id}`)).json()).dueAt))
      .toBe(localDay(expected.toISOString()))
  })

  test('массовое «Закрыть»: итог «сделано N, пропущено M»', async ({ page, request }) => {
    const run = Date.now().toString(36)
    const { createTask } = await prepare(request)
    const first = await createTask(`Массовая А ${run}`)
    const second = await createTask(`Массовая Б ${run}`)

    await page.goto('/tasks')
    await page.getByRole('radio', { name: 'Список' }).click()
    for (const title of [`Массовая А ${run}`, `Массовая Б ${run}`]) {
      await page
        .getByRole('row')
        .filter({ hasText: title })
        .getByRole('checkbox', { name: 'Выделить строку' })
        .check()
    }
    const toolbar = page.getByRole('toolbar', { name: 'Действия с выбранными задачами' })
    await expect(toolbar.getByText('Выбрано: 2')).toBeVisible()
    await toolbar.getByRole('button', { name: 'Закрыть', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Закрыть: выбрано 2' })
    await dialog.getByRole('button', { name: 'Применить' }).click()
    await expect(page.getByText('Сделано: 2, пропущено: 0').first()).toBeVisible()
    await expect(dialog).toBeHidden()

    for (const id of [first, second]) {
      expect((await (await request.get(`/api/v1/tasks/${id}`)).json()).status).toBe('done')
    }
  })

  test('серия повторяющихся задач: пауза и правка из списка «Повторяющиеся»', async ({
    page,
    request,
  }) => {
    const run = Date.now().toString(36)
    const { headers, spaceId } = await prepare(request)
    const title = `Еженедельная сверка ${run}`
    const created = await request.post('/api/v1/task-series', {
      headers,
      data: {
        template: { kind: 'task', title, spaceId },
        rule: { freq: 'weekly', interval: 1, weekdays: [1], time: '09:00' },
        dueWorkingDays: 3,
        startsOn: new Date().toLocaleDateString('sv'),
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const seriesId = (await created.json()).id as string

    await page.goto('/tasks')
    await page.getByRole('button', { name: 'Повторяющиеся' }).click()
    const dialog = page.getByRole('dialog', { name: 'Повторяющиеся' })
    const row = dialog.getByRole('listitem').filter({ hasText: title })
    await expect(row.getByText('Действует')).toBeVisible()
    await row.getByRole('button', { name: 'Приостановить' }).click()
    await expect(row.getByText('На паузе')).toBeVisible()
    expect((await (await request.get(`/api/v1/task-series/${seriesId}`)).json()).status).toBe(
      'paused',
    )

    // Правка — для следующих экземпляров: название и время создания
    await row.getByRole('button', { name: 'Изменить' }).click()
    await row.getByLabel('Название').fill(`${title} — правка`)
    await row.getByLabel('Время создания').fill('10:30')
    await row.getByRole('button', { name: 'Сохранить серию' }).click()
    await expect(page.getByText('Серия изменена — для следующих поручений')).toBeVisible()
    await expect(row.getByText(`${title} — правка`)).toBeVisible()
    await expect(row.getByText(/в 10:30/)).toBeVisible()
    const edited = await (await request.get(`/api/v1/task-series/${seriesId}`)).json()
    expect(edited).toMatchObject({ title: `${title} — правка`, status: 'paused' })
    expect(edited.rule.time).toBe('10:30')
  })
})
