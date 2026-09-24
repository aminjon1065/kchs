import type { APIRequestContext } from '@playwright/test'
import { EMPLOYEE_STATE, expect, test } from './fixtures.js'

const EMPLOYEE_LOGIN = 'user001'
const TIMEZONE = 'Asia/Dushanbe'

/** Календарный день момента в поясе установки — `ГГГГ-ММ-ДД`. */
const localDay = (at: Date | string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date(at))

/** День `ГГГГ-ММ-ДД` со сдвигом на `days` календарных дней. */
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const ruDate = (day: string) => day.split('-').reverse().join('.')
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function session(request: APIRequestContext) {
  const me = await request.get('/api/v1/me')
  expect(me.ok(), 'сессия действительна').toBeTruthy()
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const users = await request.get(`/api/v1/users?q=${EMPLOYEE_LOGIN}`)
  const employee = ((await users.json()).items as Array<{ id: string; login: string }>).find(
    (user) => user.login === EMPLOYEE_LOGIN,
  )
  expect(employee).toBeTruthy()
  return { headers, employeeId: employee?.id as string }
}

/**
 * Поручения в полном режиме (P3-E03, ADR-0082): срок в рабочих днях по
 * производственному календарю, принятие, запрос продления с обоснованием,
 * решение автора во Входящих, история сроков и отметка «продлено», отчёт и
 * приёмка; экран «Контроль» — матрица подразделений с числами-ссылками.
 */
test.describe('Поручения: полный режим и контроль исполнения', () => {
  test('срок рабочими днями → принято → продление → согласовано → отчёт → принят', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    test.setTimeout(150_000)
    const run = Date.now().toString(36)
    await session(request)
    const deadline = (await (
      await request.get('/api/v1/business-calendar/deadline?workingDays=3')
    ).json()) as { date: string; dueAt: string }

    // Автор: новое поручение со сроком «3 рабочих дня» — форма показывает итоговую дату
    const title = `Подготовить справку ${run}`
    await page.goto('/tasks')
    await page.getByRole('button', { name: 'Поручение', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Новое поручение' })
    await dialog.getByRole('textbox', { name: 'Название' }).fill(title)
    await dialog.getByRole('searchbox', { name: 'Исполнитель' }).fill(EMPLOYEE_LOGIN)
    await dialog.getByRole('list', { name: 'Исполнитель' }).getByRole('button').first().click()
    await dialog.getByRole('radio', { name: 'Рабочие дни' }).click()
    await dialog.getByRole('spinbutton', { name: 'Рабочих дней' }).fill('3')
    await expect(dialog.getByText(`Срок: ${ruDate(deadline.date)}, конец дня`)).toBeVisible()
    await dialog.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByText('Поручение создано')).toBeVisible()

    const found = await request.get(`/api/v1/tasks?scope=assigned_by_me&state=all&q=${run}`)
    const id = ((await found.json()).items as Array<{ id: string; title: string }>).find(
      (item) => item.title === title,
    )?.id as string
    expect(id).toBeTruthy()
    const created = await (await request.get(`/api/v1/tasks/${id}`)).json()
    expect(created.dueWorkingDays).toBe(3)
    expect(new Date(created.dueAt).getTime()).toBe(new Date(deadline.dueAt).getTime())

    // Исполнитель: принимает к исполнению и просит продлить срок на неделю
    const assignee = await browser.newContext({ baseURL, storageState: EMPLOYEE_STATE })
    const executor = await assignee.newPage()
    await executor.goto(`/o/${id}`)
    await executor.getByRole('button', { name: 'Принять к исполнению' }).click()
    await expect(executor.getByText('Поручение принято к исполнению')).toBeVisible()
    await executor.getByRole('button', { name: 'Запросить продление' }).click()
    const extension = executor.getByRole('dialog', { name: 'Запросить продление срока' })
    const requested = shiftDay(deadline.date, 7)
    await extension.getByLabel('Новый срок').fill(requested)
    const reason = `Нужны данные районов ${run}`
    await extension.getByRole('textbox', { name: 'Обоснование' }).fill(reason)
    await extension.getByRole('button', { name: 'Запросить продление' }).click()
    await expect(executor.getByText('Запрос продления отправлен автору')).toBeVisible()
    await expect(
      executor.getByText(`Исполнитель просит продлить срок до ${ruDate(requested)}`),
    ).toBeVisible()
    await expect(executor.getByRole('button', { name: 'Запросить продление' })).toHaveCount(0)

    // Автор: дело «Продление срока» во Входящих — срок и обоснование, согласовать
    await page.goto('/inbox')
    const authorInbox = page.getByRole('list', { name: 'Входящие' })
    const extensionItem = authorInbox.getByRole('option', {
      name: new RegExp(`Продление срока: ${escapeRegExp(title)}`),
    })
    await extensionItem.click()
    const detail = page.getByRole('article')
    await expect(detail.getByText(reason)).toBeVisible()
    await expect(detail.getByText(ruDate(requested))).toBeVisible()
    await page.getByRole('button', { name: 'Согласовать продление', exact: true }).click()
    await expect(extensionItem).toHaveCount(0)

    // Исполнитель: новый срок, отметка «Продлено», история сроков — назначен и продлён
    await executor.reload()
    const history = executor.getByRole('list', { name: 'История сроков' })
    await expect(history.getByRole('listitem')).toHaveCount(2)
    await expect(history.getByRole('listitem').nth(1)).toContainText('Продление')
    await expect(history.getByRole('listitem').nth(1)).toContainText(ruDate(requested))
    await expect(executor.getByText('Продлено', { exact: true })).toBeVisible()

    // Отчёт → приёмка автором
    await executor.getByRole('button', { name: 'Отчитаться', exact: true }).click()
    const report = executor.getByRole('dialog', { name: 'Отчёт об исполнении' })
    await report.getByRole('textbox', { name: 'Что сделано' }).fill('Справка подготовлена')
    await report.getByRole('button', { name: 'Отчитаться' }).click()
    await expect(executor.getByText('Отчёт отправлен на приёмку')).toBeVisible()

    await page.goto(`/o/${id}`)
    await page.getByRole('button', { name: 'Принять отчёт' }).click()
    await expect(page.getByText('Отчёт принят, поручение закрыто')).toBeVisible()

    const final = await (await request.get(`/api/v1/tasks/${id}`)).json()
    expect(final.status).toBe('accepted')
    expect(final.startedAt).toBeTruthy()
    expect(final.extensions).toBe(1)
    expect(localDay(final.dueAt)).toBe(requested)
    expect(localDay(final.originalDueAt)).toBe(deadline.date)
    expect((final.dueHistory as Array<{ reason: string }>).map((item) => item.reason)).toEqual([
      'set',
      'extension',
    ])
    await assignee.close()
  })

  test('«Контроль»: матрица подразделений, число-ссылка и список ячейки', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const run = Date.now().toString(36)
    const { headers } = await session(request)
    // Свой исполнитель на прогон: у сотрудника seed на общем стенде копятся десятки
    // просроченных поручений прошлых прогонов, и нужное не попадает в видимые строки
    const units = (await (await request.get('/api/v1/org/units')).json()).items as Array<{
      id: string
      code: string
    }>
    const login = `control-${run}`
    const created = await request.post('/api/v1/users', {
      headers,
      data: {
        login,
        lastName: 'Контролев',
        firstName: `Исполнитель${run}`,
        roleKeys: ['employee'],
        password: `Kontrol-${run}-2026!`,
        mustChangePassword: false,
        unitId: units.find((unit) => unit.code === 'UO')?.id ?? null,
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const employeeId = (await created.json()).id as string
    const today = localDay(new Date())
    const create = async (title: string, due: Record<string, unknown>) => {
      const response = await request.post('/api/v1/tasks', {
        headers,
        data: { kind: 'instruction', title, assigneeId: employeeId, ...due },
      })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
    const overdueTitle = `Просроченное ${run}`
    const todayTitle = `Срок сегодня ${run}`
    await create(overdueTitle, { dueAt: `${shiftDay(today, -1)}T23:59:59+05:00` })
    await create(todayTitle, { dueAt: `${today}T23:59:59+05:00` })
    await create(`В срок ${run}`, { dueWorkingDays: 5 })

    // Подразделение исполнителя — строка матрицы
    const report = await request.get(`/api/v1/tasks/control?assigneeId=${employeeId}`)
    expect(report.ok(), await report.text()).toBeTruthy()
    const rows = (await report.json()).rows as Array<{
      unitName: string | null
      unitPath: string[]
      counts: { overdue: number; dueToday: number; onTrack: number }
    }>
    expect(rows).toHaveLength(1)
    const unit = rows[0]?.unitName ?? 'Без подразделения'
    expect(rows[0]?.counts.overdue).toBeGreaterThanOrEqual(1)
    expect(rows[0]?.counts.dueToday).toBeGreaterThanOrEqual(1)
    expect(rows[0]?.counts.onTrack).toBeGreaterThanOrEqual(1)

    await page.goto('/control')
    const matrix = page.getByRole('table', { name: 'Подразделения × состояния' })
    await expect(matrix).toBeVisible()
    // Матрица и список — только по исполнителю прогона
    await page.getByRole('searchbox', { name: 'Исполнитель' }).fill(login)
    await page.getByRole('list', { name: 'Исполнитель' }).getByRole('button').first().click()
    // Строка — подразделение и его путь в оргструктуре
    const rowName = [unit, (rows[0]?.unitPath ?? []).join(' › ')].filter(Boolean).join(' ')
    await expect(matrix.getByRole('rowheader', { name: rowName, exact: true })).toBeVisible()

    // Число «Просрочено» в строке подразделения — список просроченных поручений
    await matrix
      .getByRole('button', { name: new RegExp(`^Просрочено, ${escapeRegExp(unit)}: \\d+$`) })
      .click()
    const list = page.getByRole('grid', { name: 'Поручения' })
    await expect(list.getByText(overdueTitle)).toBeVisible()
    await expect(list.getByText(todayTitle)).toHaveCount(0)

    await matrix
      .getByRole('button', { name: new RegExp(`^Срок сегодня, ${escapeRegExp(unit)}: \\d+$`) })
      .click()
    await expect(list.getByText(todayTitle)).toBeVisible()
    await expect(list.getByText(overdueTitle)).toHaveCount(0)

    // Выгрузка матрицы — файл XLSX
    await page.getByRole('button', { name: 'Выгрузить' }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Матрица — XLSX' }).click()
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/)
  })
})
