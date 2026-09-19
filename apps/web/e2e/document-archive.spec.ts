import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Шаг 6 сценария B (02-users-and-scenarios.md; P3-E02 S09, S10; ADR-0086):
 * входящее письмо → ответ исходящим одним действием со связью «в ответ на» →
 * регистрация и отметка отправки → номенклатура дел → подшивка ответа и
 * входящего в дело → закрытие дела → передача в архив → документы в архиве
 * находятся поиском с фильтром статуса. Уничтожение по акту, права и фильтры
 * списка — интеграционные тесты `apps/api/test/documents-archive.test.ts`.
 */

/** Контекст-панель оболочки: действия документа. */
const context = (page: Page) => page.getByRole('complementary', { name: 'Контекст' })

test.describe('Документы: переписка, дела и архив', () => {
  test('входящее → ответ со связью → отправка → подшивка в дело → закрытие → архив', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const run = Date.now().toString(36)
    const subject = `О готовности пунктов временного размещения ${run}`
    const index = `05-${run}`
    const caseTitle = `Переписка с Минфином ${run}`

    // Скан письма — настоящий PDF со страницей текста
    const scanPage = await page.context().newPage()
    await scanPage.setContent(`<h1>Министерство финансов</h1><p>Исх. № 14-${run}</p><p>${subject}</p>`)
    const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
    const scanPath = path.join(dir, `письмо-${run}.pdf`)
    await scanPage.pdf({ path: scanPath, format: 'A4' })
    await scanPage.close()

    // Корреспондент — из демо-сида; на стенде без него — заводится здесь
    const me = await request.get('/api/v1/me')
    const csrf = (await me.json()).session.csrfToken as string
    const found = await request.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
    if (((await found.json()).items ?? []).length === 0) {
      const created = await request.post('/api/v1/correspondents', {
        headers: { 'x-csrf-token': csrf },
        data: {
          name: 'Министерство финансов Республики Таджикистан',
          details: { shortName: 'Минфин' },
        },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
    }

    // ── Входящее письмо: регистрация со сканом ───────────────────────────────
    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await page.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const screen = page.getByRole('region', { name: 'Регистрация входящего' })
    await screen.locator('input[type="file"]').setInputFiles(scanPath)
    await expect(screen.getByRole('button', { name: 'Крупнее' })).toBeVisible({ timeout: 20_000 })
    await screen.getByRole('textbox', { name: 'Тема' }).fill(subject)
    await screen.getByRole('searchbox', { name: 'Корреспондент' }).fill('Минфин')
    await screen
      .getByRole('list', { name: 'Корреспондент' })
      .getByRole('button', { name: /Министерство финансов/ })
      .click()
    await screen.getByRole('textbox', { name: 'Исходящий номер отправителя' }).fill(`14-${run}`)
    await screen.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const registered = page.getByText(/Зарегистрирован № ВХ-\d{4}\/\d{2}/)
    await expect(registered).toBeVisible({ timeout: 15_000 })
    const incomingNumber = ((await registered.textContent()) ?? '').replace(/^.*№\s*/, '').trim()
    await page.getByRole('tab', { name: new RegExp(incomingNumber) }).click()
    await expect(page.getByText('Зарегистрирован', { exact: true }).first()).toBeVisible()

    // ── Ответ одним действием: исходящий черновик со связью «в ответ на» ─────
    const office = context(page).getByRole('region', { name: 'Делопроизводство' })
    await office.getByRole('button', { name: 'Ответить', exact: true }).click()
    await expect(page.getByText('Создан ответ', { exact: false })).toBeVisible()
    // Новая вкладка — черновик исходящего с темой и корреспондентом входящего
    await expect(page.getByRole('tab', { name: subject, exact: true })).toBeVisible()
    await expect(page.getByText('Исходящее письмо', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Черновик', { exact: true }).first()).toBeVisible()
    await expect(
      page.getByText('Министерство финансов Республики Таджикистан').first(),
    ).toBeVisible()

    // Регистрация ответа в журнале «Исходящие»
    await context(page).getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const registerDialog = page.getByRole('dialog', { name: 'Регистрация документа' })
    await expect(registerDialog.getByText(/Следующий номер: ИСХ-\d{4}\/\d{2}/)).toBeVisible()
    await registerDialog.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const outgoingToast = page.getByText(/Зарегистрирован № ИСХ-\d{4}\/\d{2}/)
    await expect(outgoingToast).toBeVisible()
    const outgoingNumber = ((await outgoingToast.textContent()) ?? '').replace(/^.*№\s*/, '').trim()

    // Отметка об отправке: адресат — корреспондент ответа; первая отправка исполняет исходящий
    await context(page)
      .getByRole('region', { name: 'Делопроизводство' })
      .getByRole('button', { name: 'Отметить отправку', exact: true })
      .click()
    const dispatch = page.getByRole('dialog', { name: 'Отметка об отправке' })
    await expect(dispatch.getByText('Министерство финансов Республики Таджикистан')).toBeVisible()
    await dispatch.getByRole('textbox', { name: 'Номер отправления' }).fill(`RR${run}TJ`)
    await dispatch.getByRole('button', { name: 'Отметить отправку', exact: true }).click()
    await expect(page.getByText('Отправка отмечена')).toBeVisible()
    await expect(page.getByText('Исполнен', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Отправка', exact: true })).toBeVisible()

    // Вкладка «Связи»: цепочка переписки и связь «в ответ на» входящее
    await page.getByRole('tab', { name: 'Связи', exact: true }).click()
    const chain = page.getByRole('region', { name: 'Переписка' })
    await expect(chain.getByRole('listitem')).toHaveCount(2)
    await expect(chain.getByText(incomingNumber)).toBeVisible()
    await expect(chain.getByText('Этот документ')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'В ответ на', exact: true })).toBeVisible()

    // ── Номенклатура дел: новое дело для исходящей переписки ────────────────
    await page.getByRole('tab', { name: /^Документы/ }).click()
    await page
      .getByRole('navigation', { name: 'Разделы документов' })
      .getByRole('button', { name: 'Номенклатура дел', exact: true })
      .click()
    const cases = page.getByRole('region', { name: 'Номенклатура дел' })
    await cases.getByRole('button', { name: 'Новое дело', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Новое дело' })
    await create.getByRole('textbox', { name: 'Индекс' }).fill(index)
    await create.getByRole('textbox', { name: 'Заголовок' }).fill(caseTitle)
    await create.getByRole('checkbox', { name: 'Исходящее письмо' }).check()
    await create.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(create).toBeHidden()
    await expect(cases.getByRole('heading', { name: caseTitle })).toBeVisible()

    // ── Подшивка ответа и входящего в дело ───────────────────────────────────
    const fileInto = async (tab: RegExp) => {
      await page.getByRole('tab', { name: tab }).click()
      await context(page)
        .getByRole('region', { name: 'Делопроизводство' })
        .getByRole('button', { name: 'Подшить в дело', exact: true })
        .click()
      const dialog = page.getByRole('dialog', { name: 'Подшить в дело' })
      await dialog.getByRole('radio', { name: new RegExp(index) }).check()
      await dialog.getByRole('button', { name: 'Подшить в дело', exact: true }).click()
      await expect(page.getByText(`Подшит в дело ${index}`)).toBeVisible()
      await expect(page.getByText('В деле', { exact: true }).first()).toBeVisible()
    }
    await fileInto(new RegExp(outgoingNumber))
    await fileInto(new RegExp(incomingNumber))
    // Дело — на вкладке «Карточка»
    await page.getByRole('tab', { name: 'Карточка', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Дело', exact: true })).toBeVisible()

    // ── Закрытие дела и передача в архив ─────────────────────────────────────
    await page.getByRole('tab', { name: /Номенклатура дел/ }).click()
    await cases.getByRole('row', { name: new RegExp(index) }).click()
    const inventory = cases.getByRole('list').filter({ hasText: outgoingNumber })
    await expect(inventory.getByRole('listitem')).toHaveCount(2)

    await cases.getByRole('button', { name: 'Закрыть дело', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Закрыть дело' }).click()
    await expect(page.getByText('Дело закрыто', { exact: true })).toBeVisible()
    await cases.getByRole('button', { name: 'Передать в архив', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Передать в архив' }).click()
    await expect(page.getByText('Дело передано в архив')).toBeVisible()
    await expect(cases.getByRole('row', { name: new RegExp(index) })).toContainText('В архиве')

    // Документы дела — в представлении «Архив»
    await page.getByRole('tab', { name: /^Документы/ }).click()
    const navigator = page.getByRole('navigation', { name: 'Разделы документов' })
    await navigator.getByRole('button', { name: 'Архив', exact: true }).click()
    await expect(page.getByRole('row', { name: new RegExp(outgoingNumber) })).toContainText(
      'В архиве',
      { timeout: 15_000 },
    )
    await expect(page.getByRole('row', { name: new RegExp(incomingNumber) })).toBeVisible()

    // ── Поиск в архиве: общий поиск с фильтром статуса ───────────────────────
    await navigator.getByRole('button', { name: 'Поиск в архиве', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Что ищем?' }).fill(run)
    await expect(page.getByRole('button', { name: /В архиве/ })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 20_000 },
    )
    await expect(page.getByRole('button', { name: new RegExp(subject) }).first()).toBeVisible({
      timeout: 20_000,
    })

    // Дашборд «Канцелярия» — в навигаторе документов
    await page.getByRole('tab', { name: /^Документы/ }).click()
    await expect(
      navigator.getByRole('button', { name: 'Дашборд «Канцелярия»', exact: true }),
    ).toBeVisible()
  })
})
