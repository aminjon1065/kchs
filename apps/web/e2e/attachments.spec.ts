import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Вложения (P0-E11 S04): файл прикрепляется к объекту в панели «Связи»,
 * виден там чипом, открывается во вкладке и открепляется. В корне
 * пространства файл не появляется — он в системной папке «Вложения».
 */
test.describe('Вложения', () => {
  test('прикрепить файл в панели «Связи», открыть и открепить', async ({ page, request }) => {
    await openWorkspace(page, request)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = await request.get('/api/v1/spaces')
    const spaceId = (await spaces.json()).items.find(
      (space: { kind: string }) => space.kind !== 'personal',
    ).id
    const run = Date.now().toString(36)
    const host = await request.post('/api/v1/folders', {
      headers,
      data: { name: `Донесение о паводке ${run}`, spaceId },
    })
    const hostId = (await host.json()).id as string

    const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
    const fileName = `схема-участка-${run}.txt`
    const filePath = path.join(dir, fileName)
    writeFileSync(filePath, 'Схема участка затопления\n', 'utf8')

    await page.goto(`/o/${hostId}`)
    await page.getByRole('button', { name: 'Связи', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Контекст' })
    await panel.locator('input[type="file"]').setInputFiles(filePath)
    await expect(page.getByText(`Прикреплено: ${fileName}`)).toBeVisible({ timeout: 20_000 })

    // Чип вложения в группе «Вложения», файл открывается во вкладке
    const chip = panel.getByRole('button', { name: new RegExp(fileName) }).first()
    await expect(chip).toBeVisible()
    await chip.click()
    await expect(page.getByRole('tab', { name: new RegExp(fileName) })).toBeVisible()

    // В корне пространства файла нет — он в системной папке
    const root = await request.get(
      `/api/v1/objects?spaceId=${spaceId}&parentId=root&types=folder,file&limit=200`,
    )
    const titles = (await root.json()).items.map((item: { title: string }) => item.title)
    expect(titles).not.toContain(fileName)
    expect(titles).not.toContain('Вложения')

    // Открепление: чип исчезает
    await page.goto(`/o/${hostId}`)
    await page.getByRole('button', { name: 'Связи', exact: true }).click()
    await panel.getByRole('button', { name: 'Открепить' }).click()
    await expect(page.getByText('Вложение откреплено')).toBeVisible()
    await expect(panel.getByRole('button', { name: new RegExp(fileName) })).toHaveCount(0)
  })
})
