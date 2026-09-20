import type { APIRequestContext } from '@playwright/test'
import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Пайплайны преобразований (P5-E03, ADR-0106): экран «Пайплайны», создание
 * поверх датасета, шаг в конструкторе, предпросмотр результата шага, прогон и
 * журнал прогонов. Созданное сценарий убирает за собой.
 */
const run = Date.now().toString(36)
const name = `Пайплайн ${run}`
const output = `${name} — результат`

/** Удаление созданного по API: пайплайн и датасет-результат не остаются на стенде. */
async function trash(request: APIRequestContext, objectIds: readonly string[]): Promise<void> {
  const me = await request.get('/api/v1/me')
  const csrfToken = (await me.json()).session.csrfToken as string
  for (const objectId of objectIds) {
    await request.delete(`/api/v1/objects/${objectId}`, { headers: { 'x-csrf-token': csrfToken } })
  }
}

test.describe('Пайплайны преобразований', () => {
  test('конструктор: шаг, предпросмотр, прогон и журнал', async ({ page, request }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Пайплайны')

    // ── Создание поверх датасета ───────────────────────────────────────────
    await page.getByRole('button', { name: 'Новый пайплайн' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новый пайплайн' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Название').fill(name)
    await dialog.getByRole('combobox', { name: 'Входной датасет' }).click()
    await page.getByRole('option').first().click()
    await dialog.getByRole('button', { name: 'Новый пайплайн' }).click()
    await expect(dialog).toBeHidden()

    // Конструктор открывается вкладкой объекта
    await expect(page.getByRole('tab', { name: new RegExp(run) })).toBeVisible()
    await expect(page.getByRole('heading', { name })).toBeVisible()
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/)
    const pipelineId = (page.url().match(/\/o\/([0-9a-f-]{36})/) ?? [])[1] as string

    // ── Шаг «Вычислить поля»: константа не зависит от схемы датасета ───────
    await expect(page.getByText('Шагов пока нет')).toBeVisible()
    await page.getByRole('combobox', { name: 'Добавить шаг' }).click()
    await page.getByRole('option', { name: 'Вычислить поля', exact: true }).click()
    const expressions = page.getByLabel('Вычисляемые поля')
    await expect(expressions).toBeVisible()
    await expressions.fill("probe = 'ok'")

    // ── Предпросмотр результата шага ───────────────────────────────────────
    await page.getByRole('button', { name: 'Показать результат шага' }).click()
    await expect(page.getByRole('columnheader', { name: 'probe' })).toBeVisible({
      timeout: 20_000,
    })

    // ── Сохранение и прогон ────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Пайплайн сохранён')).toBeVisible()
    await page.getByRole('button', { name: 'Запустить' }).click()
    await expect(page.getByText('Прогон поставлен в очередь')).toBeVisible()

    // ── Журнал прогонов ────────────────────────────────────────────────────
    await page.getByRole('tab', { name: 'Прогоны' }).click()
    await expect(page.getByText('успешно').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('вручную').first()).toBeVisible()

    // ── Результат — отдельный датасет с новой версией ──────────────────────
    const record = await request.get(`/api/v1/pipelines/${pipelineId}`)
    expect(record.ok(), 'пайплайн читается по API').toBeTruthy()
    const outputDatasetId = (await record.json()).outputDatasetId as string | null
    expect(outputDatasetId, 'прогон создал датасет-результат').toBeTruthy()

    const dataset = await request.get(`/api/v1/datasets/${outputDatasetId}`)
    expect(dataset.ok()).toBeTruthy()
    expect((await dataset.json()).name).toBe(output)

    const versions = await request.get(`/api/v1/datasets/${outputDatasetId}/versions`)
    expect(versions.ok()).toBeTruthy()
    const origins = ((await versions.json()).items as Array<{ origin: string }>).map(
      (item) => item.origin,
    )
    expect(origins).toContain('pipeline')

    await trash(request, [pipelineId, outputDatasetId as string])
  })
})
