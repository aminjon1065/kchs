import { type APIRequestContext, request as playwrightRequest } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

/**
 * Приёмка фазы 3, сценарий №5 (04-verification.md §3, ADR-0081): встреча с
 * повтором создаётся в сетке календаря с участником; приглашение приходит во
 * Входящие, участник отвечает «Да» — организатор получает ответ; напоминание
 * приходит заданием раз в минуту; срок поручения виден в календаре
 * исполнителя проекцией; ICS-подписка отдаёт события календаря и отзывается.
 */

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const DAY = 86_400_000

test.describe.configure({ mode: 'serial' })

/** Дата по Душанбе через `days` дней. */
function dushanbeDate(days: number): string {
  return new Date(Date.now() + 5 * 3_600_000 + days * DAY).toISOString().slice(0, 10)
}

/** Ближайший понедельник после сегодняшнего дня (1…7 дней вперёд). */
function nextMonday(): string {
  for (let day = 1; day <= 7; day++) {
    const date = dushanbeDate(day)
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 1) return date
  }
  throw new Error('нет понедельника')
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`).toISOString()
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/api/v1/me')
  return { 'x-csrf-token': (await me.json()).session.csrfToken as string }
}

const run = Date.now().toString(36)
const meeting = `Планёрка штаба ${run}`
const monday = nextMonday()
let meetingId = ''

test.describe('Приёмка фазы 3 — календарь (сценарий №5)', () => {
  test('встреча с повтором в сетке, приглашение во Входящих, ответ участника', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(120_000)
    const colleague = (await (await request.get('/api/v1/users?q=user001')).json()).items[0] as {
      id: string
      displayName: string
    }
    await openWorkspace(page, request)

    // Календарь с рейки: неделя по умолчанию, левая колонка с «Мой календарь»
    await page.getByRole('button', { name: 'Календарь', exact: true }).first().click()
    await expect(page.getByRole('radio', { name: 'Неделя' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    const sidebar = page.getByRole('complementary', { name: 'Календари' })
    await expect(
      sidebar.getByRole('checkbox', { name: 'Показывать «Мой календарь»' }),
    ).toBeChecked()

    // Новое событие: понедельник 10:00–10:30, по рабочим дням, участник user001
    await page.getByRole('button', { name: 'Создать', exact: true }).first().click()
    const editor = page.getByRole('dialog', { name: 'Новое событие' })
    await editor.getByRole('textbox', { name: 'Название' }).fill(meeting)
    await editor.getByLabel('Дата: Начало').fill(monday)
    await editor.getByLabel('Время: Начало').fill('10:00')
    await editor.getByLabel('Время: Окончание').fill('10:30')
    await editor.getByRole('combobox', { name: 'Повтор' }).click()
    await page.getByRole('option', { name: 'По рабочим дням (пн–пт)' }).click()
    await editor
      .getByRole('searchbox', { name: 'Пригласить сотрудника' })
      .fill(colleague.displayName)
    await editor
      .getByRole('list', { name: 'Найденные сотрудники' })
      .getByRole('button', { name: new RegExp(colleague.displayName) })
      .first()
      .click()
    await expect(editor.getByRole('list', { name: 'Участники' })).toContainText(
      colleague.displayName,
    )
    await editor.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(page.getByText('Событие создано')).toBeVisible()
    await expect(editor).toBeHidden()

    // Неделя встречи: пять повторений понедельник–пятница
    await page.getByRole('button', { name: 'Вперёд' }).click()
    await expect(page.getByRole('button', { name: new RegExp(meeting) })).toHaveCount(5)
    await page.screenshot({ path: 'test-results/calendar-p3-5-week.png' })

    const range = await (
      await request.get(
        `/api/v1/calendar/range?from=${encodeURIComponent(at(monday, '00:00'))}&to=${encodeURIComponent(at(addDays(monday, 7), '00:00'))}`,
      )
    ).json()
    const occurrences = (range.items as Array<{ eventId: string; title: string }>).filter(
      (item) => item.title === meeting,
    )
    expect(occurrences).toHaveLength(5)
    meetingId = occurrences[0]?.eventId ?? ''
    expect(meetingId).toBeTruthy()

    // Поповер: детали, участник ещё не ответил
    await page
      .getByRole('button', { name: new RegExp(meeting) })
      .first()
      .click()
    const popover = page.getByRole('dialog').filter({ hasText: meeting })
    await expect(popover.getByText('По рабочим дням (пн–пт)')).toBeVisible()
    await expect(popover.getByText(colleague.displayName)).toBeVisible()
    await expect(popover.getByText('Ждёт ответа')).toBeVisible()
    // «Подробнее» — событие во вкладке: карточка, правка, обсуждение в правой панели
    await popover.getByRole('button', { name: 'Подробнее' }).click()
    const eventTab = page.getByRole('tab', { name: new RegExp(meeting) })
    await expect(eventTab).toBeVisible()
    await expect(page.getByRole('button', { name: 'Изменить', exact: true }).first()).toBeVisible()
    await expect(page.getByText('По рабочим дням (пн–пт)').first()).toBeVisible()
    await page.getByRole('tab', { name: /Календарь/ }).click()

    // Участник: приглашение во Входящих — «Да»
    const context = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    await resetWorkspaceState(context.request)
    const other = await context.newPage()
    await openWorkspace(other, context.request)
    await other.getByRole('button', { name: 'Входящие', exact: true }).first().click()
    await other
      .getByRole('option', { name: new RegExp(`Приглашение: ${meeting}`) })
      .first()
      .click()
    await other.getByRole('button', { name: 'Да', exact: true }).click()
    await expect(other.getByText('Выполнено')).toBeVisible()
    const answered = await (await context.request.get(`/api/v1/events/${meetingId}`)).json()
    expect(answered.myStatus).toBe('accepted')

    // Встреча — в календаре участника (приглашения показываются в личном)
    await other.getByRole('button', { name: 'Календарь', exact: true }).first().click()
    await other.getByRole('radio', { name: 'Повестка' }).click()
    await expect(other.getByRole('button', { name: new RegExp(meeting) }).first()).toBeVisible()
    await context.close()

    // Организатор узнаёт об ответе
    await expect
      .poll(
        async () => {
          const list = await (await request.get('/api/v1/notifications?limit=50')).json()
          return (list.items as Array<{ title: string }>).some((item) =>
            item.title.includes(`примет участие в «${meeting}»`),
          )
        },
        { timeout: 20_000 },
      )
      .toBe(true)
  })

  test('напоминание о встрече приходит участнику заданием раз в минуту', async ({ request }) => {
    test.setTimeout(240_000)
    const colleague = (await (await request.get('/api/v1/users?q=user001')).json()).items[0] as {
      id: string
    }
    const title = `Созвон с районом ${run}`
    // Начало через 3,5 минуты, напоминание за 2 минуты — срабатывает примерно через 1,5 минуты
    const start = Math.ceil((Date.now() + 210_000) / 60_000) * 60_000
    const created = await request.post('/api/v1/events', {
      headers: await csrf(request),
      data: {
        title,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 30 * 60_000).toISOString(),
        attendees: [{ userId: colleague.id }],
        reminders: [{ minutes: 2, channels: ['app'] }],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()

    const context = await playwrightRequest.newContext({
      baseURL: BASE,
      storageState: EMPLOYEE_STATE,
    })
    await expect
      .poll(
        async () => {
          const list = await (await context.get('/api/v1/notifications?limit=50')).json()
          return (list.items as Array<{ title: string }>).some((item) =>
            item.title.startsWith(`Напоминание: «${title}»`),
          )
        },
        { timeout: 200_000, intervals: [5_000] },
      )
      .toBe(true)
    await context.dispose()
  })

  test('срок поручения — проекцией в календаре исполнителя', async ({ request, browser }) => {
    test.setTimeout(90_000)
    const colleague = (await (await request.get('/api/v1/users?q=user001')).json()).items[0] as {
      id: string
    }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      key: string
    }>
    const space = spaces.find((item) => item.key === 'flood-2026') ?? spaces[0]
    const title = `Сводка по паводку ${run}`
    const created = await request.post('/api/v1/tasks', {
      headers: await csrf(request),
      data: {
        kind: 'instruction',
        title,
        spaceId: space?.id,
        assigneeId: colleague.id,
        dueAt: at(dushanbeDate(2), '15:00'),
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()

    const context = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    await resetWorkspaceState(context.request)
    const page = await context.newPage()
    await openWorkspace(page, context.request)
    await page.getByRole('button', { name: 'Календарь', exact: true }).first().click()
    await expect(page.getByRole('checkbox', { name: 'Сроки задач и поручений' })).toBeChecked()
    await page.getByRole('radio', { name: 'Повестка' }).click()
    const deadline = page.getByRole('button', { name: new RegExp(`Срок: ${title}`) })
    await expect(deadline).toBeVisible()
    await deadline.click()
    const popover = page.getByRole('dialog').filter({ hasText: title })
    await expect(popover.getByText('Задача', { exact: true })).toBeVisible()
    await popover.getByRole('button', { name: 'Открыть' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(title) })).toBeVisible()
    await context.close()
  })

  test('ICS-подписка отдаёт события календаря и отзывается', async ({ page, request }) => {
    test.setTimeout(90_000)
    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Календарь', exact: true }).first().click()
    await page.getByRole('button', { name: 'Действия с календарём «Мой календарь»' }).click()
    await page.getByRole('menuitem', { name: 'Ссылка для подписки (ICS)' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ссылка для подписки' })
    await dialog.getByRole('button', { name: 'Создать ссылку' }).click()
    const url = await dialog.getByLabel('Новая ссылка').inputValue()
    expect(url).toMatch(/\/api\/v1\/calendar-feeds\/[A-Za-z0-9_-]+\.ics$/)

    // Лента публичная по токену: без сессии, с правами выпустившего
    const anonymous = await playwrightRequest.newContext()
    const feed = await anonymous.get(url)
    expect(feed.status()).toBe(200)
    expect(feed.headers()['content-type']).toContain('text/calendar')
    const ics = (await feed.text()).replace(/\r\n[ \t]/g, '')
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain(`SUMMARY:${meeting}`)
    expect(ics).toMatch(/RRULE:FREQ=WEEKLY;[^\r\n]*BYDAY=MO,TU,WE,TH,FR/)
    expect(ics).toContain('BEGIN:VTIMEZONE')

    // Отозванная ссылка больше не работает
    await dialog.getByRole('button', { name: 'Отозвать' }).first().click()
    await expect(page.getByText('Ссылка отозвана')).toBeVisible()
    expect((await anonymous.get(url)).status()).toBe(404)
    await anonymous.dispose()
    await page.screenshot({ path: 'test-results/calendar-p3-5-feed.png' })
    await page.keyboard.press('Escape')

    // Календарь во вкладке: вид, ближайшие события, «Показать в календаре»
    await page.getByRole('button', { name: 'Действия с календарём «Мой календарь»' }).click()
    await page.getByRole('menuitem', { name: 'Открыть' }).click()
    await expect(page.getByRole('tab', { name: /Мой календарь/ })).toBeVisible()
    await expect(page.getByText('Ближайшие две недели')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Показать в календаре' })).toBeVisible()
  })
})
