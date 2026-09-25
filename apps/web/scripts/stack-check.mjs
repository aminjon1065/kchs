#!/usr/bin/env node
/**
 * Браузерная проверка установки в контейнерах (infra/scripts/verify-stack.sh):
 * вход через web (Caddy со сборкой SPA и CSP), «Мой день», загрузка файла
 * напрямую в S3 и превью, которое делает движок. Любое нарушение CSP — ошибка.
 *
 *   STACK_URL=http://localhost:8080 STACK_ADMIN_PASSWORD=… \
 *   STACK_S3_ORIGIN=http://localhost:9000 node scripts/stack-check.mjs
 *
 * Администратор должен уже сменить временный пароль от `kchs init`.
 * STACK_IGNORE_TLS=1 — стенд с сертификатом внутреннего центра Caddy (домен localhost,
 * проверка режима HTTPS стенда демонстрации, ADR-0148).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'

const BASE = process.env.STACK_URL ?? 'http://localhost:8080'
const LOGIN = process.env.STACK_ADMIN_LOGIN ?? 'admin'
const PASSWORD = process.env.STACK_ADMIN_PASSWORD
const S3_ORIGIN = process.env.STACK_S3_ORIGIN ?? 'http://localhost:9000'
if (!PASSWORD) {
  process.stderr.write('STACK_ADMIN_PASSWORD не задан\n')
  process.exit(2)
}

const failures = []
const log = (message) => process.stdout.write(`${message}\n`)

async function step(name, action) {
  try {
    await action()
    log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    log(`  ✗ ${name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'ru-RU',
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: process.env.STACK_IGNORE_TLS === '1',
})
await context.addInitScript(() => {
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`)
  })
})
const page = await context.newPage()
log(`Проверка установки в браузере: ${BASE}`)

await step('web отдаёт SPA со строгим CSP и nonce', async () => {
  const response = await page.goto(BASE)
  if (!response?.ok()) throw new Error(`статус ${response?.status()}`)
  const headers = response.headers()
  const csp = headers['content-security-policy'] ?? ''
  if (!/style-src 'self' 'nonce-[0-9a-f-]{36}'/.test(csp)) throw new Error('нет CSP с nonce')
  if (headers['x-frame-options'] !== 'DENY') throw new Error('нет X-Frame-Options: DENY')
})

await step('вход администратора и «Мой день»', async () => {
  await page.getByLabel('Логин или почта').fill(LOGIN)
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('tab', { name: /Мой день/ }).waitFor({ timeout: 30_000 })
})

const fileName = `проверка-установки-${Date.now().toString(36)}.png`
await step('загрузка файла напрямую в S3', async () => {
  await page.goto(`${BASE}/files`)
  await page.getByRole('button', { name: 'Новая папка' }).waitFor({ timeout: 20_000 })
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-stack-'))
  const png = path.join(dir, fileName)
  // Непрозрачный PNG 1×1: движок делает из него превью WebP
  writeFileSync(
    png,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  await page.locator('input[type="file"]').first().setInputFiles(png)
  await page.getByText(`Загружен «${fileName}»`).waitFor({ timeout: 30_000 })
})

await step('превью от движка из S3 во вкладке файла', async () => {
  const found = await page.request.get(
    `${BASE}/api/v1/objects?type=file&q=${encodeURIComponent(fileName)}&limit=1`,
  )
  const fileId = (await found.json()).items?.[0]?.id
  if (!fileId) throw new Error('загруженный файл не найден через API')
  await page.goto(`${BASE}/o/${fileId}`)
  await page.getByRole('tab', { name: new RegExp(fileName) }).waitFor({ timeout: 20_000 })
  await page.locator(`img[src^="${S3_ORIGIN}"]`).first().waitFor({ timeout: 90_000 })
})

await step('нарушений CSP нет', async () => {
  const violations = await page.evaluate(() => window.__cspViolations)
  if (violations.length > 0) throw new Error(violations.join('; '))
})

await browser.close()
if (failures.length > 0) {
  log(`Не прошло: ${failures.join(', ')}`)
  process.exit(1)
}
log('Установка работает в браузере')
