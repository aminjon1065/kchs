import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Качество данных (P5-E03, ADR-0101): правило с параметрами заводится в
 * карточке датасета и проверяется кнопкой. До этой проверки половина видов
 * правил сохранялась без параметров и падала при запуске (вопрос N87).
 */
test.describe('Данные: правила качества', () => {
  test('правило «число в диапазоне» с границами находит нарушение', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id

    const dataset = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Показания ${run}`,
        spaceId,
        fields: [
          { key: 'post', label: { ru: 'Пост' }, type: 'text' },
          { key: 'level', label: { ru: 'Уровень' }, type: 'integer' },
        ],
      },
    })
    expect(dataset.ok(), await dataset.text()).toBeTruthy()
    const datasetId = (await dataset.json()).id as string
    await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: [{ values: { post: 'А', level: 50 } }, { values: { post: 'Б', level: 900 } }],
      },
    })

    try {
      await openWorkspace(page, request)
      await page.goto(`/o/${datasetId}`)
      await page.getByRole('tab', { name: 'Качество' }).click()

      await page.getByRole('button', { name: 'Добавить правило' }).click()
      const key = page.getByRole('textbox', { name: 'Ключ' }).last()
      await key.fill(`level_range_${run}`)
      await page.getByRole('combobox', { name: 'Вид' }).last().click()
      await page.getByRole('option', { name: 'Число в диапазоне' }).click()
      await page.getByRole('combobox', { name: 'Поле' }).last().click()
      await page.getByRole('option', { name: 'Уровень' }).click()
      // Границы правила — то, чего в конструкторе не было
      await page.getByRole('spinbutton', { name: 'Не меньше' }).fill('0')
      await page.getByRole('spinbutton', { name: 'Не больше' }).fill('100')
      await page.getByRole('button', { name: 'Сохранить' }).first().click()
      await expect(page.getByText('Правила сохранены')).toBeVisible({ timeout: 20_000 })

      await page.getByRole('button', { name: 'Проверить сейчас' }).click()
      // Нарушение считается по границам правила: 900 вне диапазона 0…100
      await expect(page.getByText(/строк с нарушением: 1/)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('Есть нарушения')).toBeVisible()
    } finally {
      await request.delete(`/api/v1/objects/${datasetId}`, { headers })
    }
  })
})
