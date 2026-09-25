import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Сценарий приёмки фазы 2 №5 (P2-E04 S05, ADR-0077): «Паспорт территории:
 * показатели, карта, документы (заглушки), поручения; переход в район».
 * Данные — по API: происшествия в районах Хатлона со слоем и поручение по
 * району; паспорт открывается со справочника территорий.
 */

interface Territory {
  id: string
  code: string
  parentId: string | null
  level: string
  name: { ru: string }
  centroid: { lon: number; lat: number } | null
}

const DAY = 86_400_000

test.describe('GIS: паспорт территории', () => {
  test('сценарий 5: показатели, карта, вкладки, поручения, переход в район и обратно', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id as string
    const territories = (await (await request.get('/api/v1/territories')).json())
      .items as Territory[]
    const region = territories.find((item) => item.code === 'TJ-KT') as Territory
    const districts = territories
      .filter((item) => item.parentId === region.id && item.level === 'district' && item.centroid)
      .slice(0, 4)
    const district = districts[0] as Territory

    // Происшествия: в каждом из четырёх районов, свежие и годом раньше
    const name = `Происшествия ${run}`
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name,
        spaceId,
        timeField: 'occurred_at',
        territoryField: 'territory',
        fields: [
          { key: 'code', label: { ru: 'Номер' }, type: 'identifier', semantic: 'identifier' },
          { key: 'occurred_at', label: { ru: 'Дата' }, type: 'datetime', semantic: 'time' },
          { key: 'territory', label: { ru: 'Территория' }, type: 'territory' },
          { key: 'damage', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const rows = districts.flatMap((item, index) =>
      Array.from({ length: 2 + index }, (_, n) => ({
        values: {
          code: `INC-${run}-${index}-${n}`,
          occurred_at: new Date(Date.now() - (n === 0 ? 400 : n * 3) * DAY).toISOString(),
          territory: item.id,
          damage: 1000 * (n + 1),
          place: { type: 'Point', coordinates: [item.centroid?.lon, item.centroid?.lat] },
        },
      })),
    )
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: { rows },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()
    const layer = await request.post('/api/v1/gis/layers', {
      headers,
      data: { name: `${name} — слой`, spaceId, datasetId },
    })
    expect(layer.ok(), await layer.text()).toBeTruthy()
    const task = await request.post('/api/v1/tasks', {
      headers,
      data: {
        kind: 'instruction',
        title: `Проверить дамбу ${run}`,
        assigneeId: me.user.id,
        dueAt: new Date(Date.now() + 7 * DAY).toISOString(),
        territoryId: district.id,
      },
    })
    expect(task.ok(), await task.text()).toBeTruthy()

    // Документ района — реквизитом «Территория» (ADR-0158)
    const types = (await (await request.get('/api/v1/document-types')).json()).items as Array<{
      id: string
    }>
    const subject = `О паводковой обстановке ${run}`
    const document = await request.post('/api/v1/documents', {
      headers,
      data: { typeId: types[0]?.id, subject, territoryId: district.id },
    })
    expect(document.ok(), await document.text()).toBeTruthy()

    // Справочник → карточка региона → паспорт
    await page.goto('/territories')
    await page
      .getByRole('list', { name: 'Территории' })
      .getByRole('button', { name: 'Хатлонская область', exact: true })
      .click()
    await expect(page.getByRole('heading', { name: 'Хатлонская область' })).toBeVisible()
    await page.getByRole('button', { name: 'Паспорт территории' }).click()
    await expect(page.getByRole('tab', { name: /Хатлонская область/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Хатлонская область' })).toBeVisible()
    await expect(
      page.getByRole('navigation').getByRole('button', { name: 'Республика Таджикистан' }),
    ).toBeVisible()

    // Показатели: строки датасета за 12 месяцев, сравнение с прошлыми 12
    const indicators = page.getByRole('region', { name: 'Показатели' })
    const card = indicators.getByRole('article', { name })
    const tile = card.getByRole('button')
    await expect(tile).toBeVisible({ timeout: 30_000 })
    await expect(tile).toContainText('10')
    await expect(tile).toContainText('к предыдущим 12 месяцам')
    await expect(card.getByText('Сумма «Ущерб»')).toBeVisible()
    await expect(card.getByText('30 000')).toBeVisible()
    // Карта с границей и объектами слоя внутри территории
    await expect(
      page.getByRole('region', { name: 'Карта территории «Хатлонская область»' }),
    ).toBeVisible()
    await expect(page.getByRole('checkbox', { name: `${name} — слой` })).toBeChecked()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'test-results/gis-passport.png', fullPage: true })

    // Данные: щелчок по показателю — строки датасета в территории
    await tile.click()
    await expect(page.getByRole('tab', { name: /^Данные/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(
      page
        .getByRole('list', { name: 'Датасеты с территорией' })
        .getByRole('button', { name: new RegExp(`^${name}`) }),
    ).toHaveAttribute('aria-pressed', 'true')
    const table = page.getByRole('grid', { name: `Строки датасета «${name}» в территории` })
    await expect(table.getByText(`INC-${run}-0-0`)).toBeVisible()
    await expect(page.getByText('Показано 14 из 14')).toBeVisible()
    // Объекты: слой датасета
    await page.getByRole('tab', { name: /^Объекты/ }).click()
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: `${name} — слой` })
        .getByRole('button', { name: 'Открыть слой' }),
    ).toBeVisible()
    // Документы: документ района — и в паспорте региона, с тем, как он связан
    await page.getByRole('tab', { name: /^Документы/ }).click()
    const documents = page.getByRole('grid', { name: 'Документы' })
    await expect(documents.getByText(subject)).toBeVisible()
    await expect(documents.getByText('Реквизит «Территория»').first()).toBeVisible()
    // Поручения: поручение района — и в паспорте региона
    await page.getByRole('tab', { name: /^Поручения/ }).click()
    await expect(page.getByText(`Проверить дамбу ${run}`)).toBeVisible()
    // Дочерние территории: таблица районов и мини-хороплет
    await page.getByRole('tab', { name: /^Дочерние территории/ }).click()
    await expect(page.getByRole('region', { name: 'Карта вложенных единиц' })).toBeVisible()
    const children = page.getByRole('grid', { name: 'Дочерние территории' })
    await expect(children.getByText(district.name.ru, { exact: true })).toBeVisible()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'test-results/gis-passport-children.png', fullPage: true })

    // Переход в район: паспорт района, его поручение, назад по крошкам
    await children.getByText(district.name.ru, { exact: true }).dblclick()
    await expect(page.getByRole('heading', { name: district.name.ru })).toBeVisible()
    await expect(page.getByRole('tab', { name: new RegExp(district.name.ru) })).toBeVisible()
    await page.getByRole('tab', { name: /^Поручения/ }).click()
    await expect(page.getByText(`Проверить дамбу ${run}`)).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: 'Хатлонская область' }).click()
    await expect(page.getByRole('heading', { name: 'Хатлонская область' })).toBeVisible()

    // Уборка: на общем стенде открытые поручения прогонов копились бы в паспорте района, и
    // свежее уходило бы за пределы видимой части таблицы
    const cancelled = await request.post(`/api/v1/tasks/${(await task.json()).id}/cancel`, {
      headers,
      data: { comment: 'Сценарий проверки завершён' },
    })
    expect(cancelled.ok(), await cancelled.text()).toBeTruthy()
  })
})
