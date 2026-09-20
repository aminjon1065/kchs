import { EMPLOYEE_STATE, expect, openScreen, openWorkspace, test } from './fixtures.js'

const BASE = 'http://localhost:5173'

/**
 * Каталог LDAP/AD, единый вход OIDC и ключи входа (P5-E04, ADR-0098).
 *
 * Каталог и провайдер на стенде не подняты — сценарий проверяет то, что от них
 * не зависит: настройка сохраняется, секрет наружу не возвращается, «Проверить
 * соединение» честно сообщает об отказе, а предпросмотр и прогон недоступны,
 * пока подключение выключено. Ключ входа проверяется целиком: у Chromium есть
 * встроенное виртуальное устройство WebAuthn.
 */
test.describe('Каталог, единый вход и ключи входа', () => {
  test('каталог: настройка сохраняется, пароль чтения не возвращается, проверка соединения сообщает об отказе', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Каталог (LDAP/AD)' }).click()

    // Порт 1 никто не слушает: соединение не установится быстро и предсказуемо
    await page.getByLabel('Адрес каталога').fill('ldap://127.0.0.1:1')
    await page.getByLabel('Учётная запись чтения (DN)').fill('cn=reader,dc=example,dc=org')
    await page.getByLabel('Пароль учётной записи чтения').fill('секрет-стенда')
    await page.getByLabel('Корень поиска сотрудников').fill('ou=people,dc=example,dc=org')
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Настройка каталога сохранена')).toBeVisible()

    // Пароль сервер обратно не отдаёт: поле пустое, подпись сообщает, что он задан
    await page.reload()
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Каталог (LDAP/AD)' }).click()
    await expect(page.getByLabel('Адрес каталога')).toHaveValue('ldap://127.0.0.1:1')
    await expect(page.getByLabel('Пароль учётной записи чтения')).toHaveValue('')
    await expect(page.getByText('Пароль задан. Пустое поле оставит прежний')).toBeVisible()

    // Выключенное подключение не даёт ни предпросмотра, ни прогона
    await expect(page.getByRole('button', { name: 'Предпросмотр' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Синхронизировать сейчас' })).toBeDisabled()

    await page.getByRole('button', { name: 'Проверить соединение' }).click()
    await expect(page.getByText(/Соединение не установлено/)).toBeVisible({ timeout: 30_000 })
  })

  test('единый вход: адрес возврата подсказан, секрет клиента не возвращается', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Единый вход' }).click()

    await expect(page.getByText(`${BASE}/api/v1/auth/sso/callback`)).toBeVisible()

    await page.getByLabel('Адрес издателя').fill('http://127.0.0.1:1/realms/kchs')
    await page.getByLabel('Идентификатор клиента').fill('kchs-stand')
    await page.getByLabel('Секрет клиента').fill('секрет-клиента-стенда')
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Настройка единого входа сохранена')).toBeVisible()

    await page.reload()
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Единый вход' }).click()
    await expect(page.getByLabel('Секрет клиента')).toHaveValue('')
    await expect(page.getByText('Секрет задан. Пустое поле оставит прежний')).toBeVisible()

    await page.getByRole('button', { name: 'Проверить соединение' }).click()
    await expect(page.getByText(/Соединение не установлено/)).toBeVisible({ timeout: 30_000 })

    // Выключенный единый вход не показывает кнопку на экране входа
    const anonymous = await page
      .context()
      .browser()
      ?.newContext({ baseURL: BASE, storageState: undefined })
    if (anonymous) {
      const login = await anonymous.newPage()
      await login.goto('/')
      await expect(login.getByLabel('Логин или почта')).toBeVisible({ timeout: 20_000 })
      await expect(login.getByRole('button', { name: /корпоративн/i })).toHaveCount(0)
      await anonymous.close()
    }
  })

  test('ключ входа: сотрудник добавляет ключ в профиле и входит по нему без пароля', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    const page = await context.newPage()

    // Виртуальное устройство Chromium: ключ с подтверждением личности,
    // как отпечаток или PIN на настоящем ноутбуке
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })

    // Ключ снимается в любом случае: иначе учётная запись останется со вторым
    // фактором и следующие прогоны не войдут под сотрудником
    try {
      await page.goto('/')
      await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
      await page.goto('/profile')

      await page.getByLabel('Название ключа').fill('Ключ сценария')
      await page.getByRole('button', { name: 'Добавить ключ' }).click()
      await expect(page.getByText('Ключ добавлен')).toBeVisible({ timeout: 20_000 })
      const row = page.getByRole('listitem').filter({ hasText: 'Ключ сценария' })
      await expect(row).toBeVisible()
      await expect(row.getByText('Подтверждает личность')).toBeVisible()

      // Выход и вход по ключу: пароль не вводится
      await page.getByRole('button', { name: 'Выйти' }).first().click()
      await expect(page.getByLabel('Логин или почта')).toBeVisible({ timeout: 20_000 })
      await page.getByRole('button', { name: 'Войти по ключу' }).click()
      await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 30_000 })
    } finally {
      // Ключ снимается в любом случае — запросом, а не через интерфейс: при
      // падении посреди сценария страница может быть где угодно, а ключ делает
      // учётную запись двухфакторной и ломает вход другим сценариям
      const me = await context.request.get('/api/v1/me')
      if (me.ok()) {
        const csrf = (await me.json()).session.csrfToken as string
        const keys = await context.request.get('/api/v1/me/passkeys')
        const items = keys.ok() ? ((await keys.json()).items as Array<Record<string, string>>) : []
        for (const key of items.filter((item) => item.name === 'Ключ сценария')) {
          await context.request.delete(`/api/v1/me/passkeys/${key.id}`, {
            headers: { 'x-csrf-token': csrf },
          })
        }
      }
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
      await context.close()
    }
  })
})
