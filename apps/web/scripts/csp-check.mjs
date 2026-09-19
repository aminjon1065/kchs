#!/usr/bin/env node
/**
 * Проверка CSP на продакшен-сборке (17-security.md §2, ADR-0043).
 *
 * Собранный web отдаёт настоящий Caddy с тем же Caddyfile, что и в развёртывании
 * (заголовки, nonce запроса, шаблон index.html), API проксируется на :3000 хоста.
 * Playwright обходит ключевые экраны с диалогами, поповерами, палитрой команд,
 * разделением панелей и загрузкой файла в S3 и собирает события
 * securitypolicyviolation — любое нарушение или несработавший шаг роняют проверку.
 *
 *   pnpm --filter @kchs/web csp:check              # сборка + проверка
 *   pnpm --filter @kchs/web csp:check --no-build   # уже собранный dist
 *
 * Нужны: Docker, запущенный api на :3000, сид (вход администратора).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, request as playwrightRequest } from '@playwright/test'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(WEB, '../..')
const CADDYFILE = path.join(ROOT, 'infra/compose/caddy/Caddyfile')
const DIST = path.join(WEB, 'dist')
const PORT = Number(process.env.CSP_CHECK_PORT ?? 8088)
const BASE = `http://localhost:${PORT}`
const CONTAINER = 'kchs-csp-check'
const CADDY_IMAGE = 'caddy:2-alpine'
const API_UPSTREAM = process.env.KCHS_API_UPSTREAM ?? 'host.docker.internal:3000'
const ADMIN = {
  login: 'admin',
  password: process.env.SEED_ADMIN_PASSWORD ?? 'Kchs!Start-2026-7q',
}
const NONCE_TEMPLATE = '{{placeholder `http.request.uuid`}}'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const violations = []
const failures = []
const warnings = []
// Снимки экрана несработавших шагов — для разбора (в CI попадают в артефакты)
const SHOTS = path.join(WEB, 'test-results', 'csp-check')

function log(message) {
  process.stdout.write(`${message}\n`)
}

/** Значение из окружения, иначе из .env корня (секреты не печатаются). */
function envValue(key) {
  if (process.env[key]) return process.env[key]
  const file = path.join(ROOT, '.env')
  if (!existsSync(file)) return undefined
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match?.[1] === key) return match[2]?.replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** Origin S3 для браузера — как в compose: KCHS_STORAGE_ORIGIN или origin эндпоинта. */
function storageOrigin() {
  const explicit = envValue('KCHS_STORAGE_ORIGIN')
  if (explicit) return explicit
  const endpoint =
    envValue('S3_PUBLIC_ENDPOINT') ?? envValue('S3_ENDPOINT') ?? 'http://localhost:9000'
  return new URL(endpoint).origin
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...options })
}

async function waitForServer() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/`)
      if (response.ok) return
    } catch {
      // сервер ещё не поднялся
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Caddy не ответил на ${BASE} за 60 с`)
}

/** Сборка не должна содержать встроенных скриптов, а шаблон nonce — дойти до dist. */
function checkBuiltHtml() {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8')
  if (!html.includes(NONCE_TEMPLATE)) {
    failures.push('dist/index.html: нет шаблона nonce — сборка его изменила или удалила')
  }
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/\bsrc=/.test(tag)) failures.push(`dist/index.html: встроенный скрипт ${tag}`)
  }
  if (/<style\b/i.test(html)) failures.push('dist/index.html: встроенный <style>')
  if (/\sstyle="/i.test(html)) failures.push('dist/index.html: атрибут style')
}

/** Nonce в заголовке совпадает с <meta> и различается между запросами. */
async function checkNonce() {
  const seen = new Set()
  for (const route of ['/', '/files', '/o/00000000-0000-4000-8000-000000000000']) {
    const response = await fetch(`${BASE}${route}`)
    const csp = response.headers.get('content-security-policy') ?? ''
    const html = await response.text()
    const header = /'nonce-([^']+)'/.exec(csp)?.[1]
    const meta = /<meta name="csp-nonce" content="([^"]*)"/.exec(html)?.[1]
    if (!header || !UUID.test(header)) failures.push(`${route}: в CSP нет nonce`)
    if (header !== meta) failures.push(`${route}: nonce заголовка и <meta> различаются`)
    if (header) seen.add(header)
    if (response.headers.get('x-frame-options') !== 'DENY') {
      failures.push(`${route}: нет X-Frame-Options: DENY`)
    }
    if (!/no-store/.test(response.headers.get('cache-control') ?? '')) {
      failures.push(`${route}: страница с nonce кешируется`)
    }
  }
  if (seen.size !== 3) failures.push('nonce повторяется между запросами')
}

/** Сессия администратора через тот же прокси. */
async function signIn(file) {
  const context = await playwrightRequest.newContext({ baseURL: BASE })
  const response = await context.post('/api/v1/auth/login', {
    data: { login: ADMIN.login, password: ADMIN.password, rememberDevice: false },
  })
  if (!response.ok()) {
    throw new Error(`вход администратора: ${response.status()} ${await response.text()}`)
  }
  // Рабочая область — с чистого листа, как у e2e: вкладки и разделение панелей
  // прошлых прогонов меняют исход шагов
  const me = await context.get('/api/v1/me')
  const csrf = (await me.json()).session.csrfToken
  const cleared = await context.put('/api/v1/me/workspace-state', {
    data: { state: null },
    headers: { 'x-csrf-token': csrf },
  })
  if (!cleared.ok()) throw new Error(`сброс рабочей области: ${cleared.status()}`)
  await context.storageState({ path: file })
  await context.dispose()
}

async function collectViolations(context, label) {
  await context.exposeBinding('__kchsCspViolation', (_source, violation) => {
    violations.push({ ...violation, where: label() })
  })
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__kchsCspViolation({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        source: event.sourceFile,
        line: event.lineNumber,
        sample: event.sample,
      })
    })
  })
}

async function step(name, action, state) {
  state.current = name
  try {
    await action()
    log(`  ✓ ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Первая строка ошибки Playwright + локатор из журнала вызова
    const waiting = /waiting for (.+)/.exec(message)?.[1]
    failures.push(`${name}: ${message.split('\n')[0]}${waiting ? ` — ${waiting}` : ''}`)
    const shot = path.join(SHOTS, `${failures.length}.png`)
    await state.page
      ?.screenshot({ path: shot })
      .then(() => log(`  ✗ ${name} (снимок: ${path.relative(WEB, shot)})`))
      .catch(() => log(`  ✗ ${name}`))
  }
}

async function crawl(browser, storageFile, s3Origin) {
  const state = { current: 'вход' }
  const label = () => state.current

  // Экран входа — без сессии
  const guest = await browser.newContext({ baseURL: BASE, locale: 'ru-RU' })
  await collectViolations(guest, label)
  const loginPage = await guest.newPage()
  state.page = loginPage
  await step(
    'экран входа',
    async () => {
      await loginPage.goto('/')
      await loginPage.getByRole('button', { name: 'Войти', exact: true }).waitFor()
    },
    state,
  )
  await guest.close()

  const context = await browser.newContext({
    baseURL: BASE,
    storageState: storageFile,
    locale: 'ru-RU',
    viewport: { width: 1440, height: 900 },
  })
  await collectViolations(context, label)
  const page = await context.newPage()
  state.page = page

  const palette = async (query) => {
    await page.keyboard.press('Meta+k')
    const input = page.getByPlaceholder(/Поиск объектов/)
    await input.waitFor()
    await input.fill(query)
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: 'Палитра команд' }).waitFor({ state: 'hidden' })
  }

  await step(
    'рабочее пространство и realtime',
    async () => {
      await page.goto('/')
      await page.getByRole('tab', { name: /Мой день/ }).waitFor({ timeout: 20_000 })
      await page.getByText('На связи').waitFor({ timeout: 15_000 })
    },
    state,
  )

  await step(
    'палитра команд и «Файлы»',
    async () => {
      await palette('Файлы')
      await page.getByRole('tab', { name: /Файлы/ }).waitFor()
      await page.getByRole('grid').waitFor()
    },
    state,
  )

  await step(
    'диалог «Новая папка»',
    async () => {
      await page.getByRole('button', { name: 'Новая папка' }).click()
      await page.getByLabel('Имя папки').waitFor()
      await page.keyboard.press('Escape')
    },
    state,
  )

  await step(
    'поповер фильтра',
    async () => {
      await page.getByRole('button', { name: 'Фильтр', exact: true }).first().click()
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
    },
    state,
  )

  const fileName = `csp-проверка-${Date.now().toString(36)}.png`
  await step(
    'загрузка файла напрямую в S3',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'kchs-csp-'))
      const png = path.join(dir, fileName)
      writeFileSync(
        png,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64',
        ),
      )
      await page.locator('input[type="file"]').first().setInputFiles(png)
      // Строка файла может быть вне видимой части виртуального списка — ждём уведомление
      await page.getByText(`Загружен «${fileName}»`).waitFor({ timeout: 20_000 })
    },
    state,
  )

  await step(
    'диалог «Поделиться» и выбор уровня',
    async () => {
      const row = page.getByRole('grid').getByRole('row').nth(1)
      await row.hover()
      await row.getByRole('button', { name: 'Поделиться' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await dialog.getByRole('combobox').first().click()
      await page.getByRole('option').first().waitFor()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
    },
    state,
  )

  await step(
    'вкладка файла: превью из S3 и контекстная панель',
    async () => {
      const found = await page.request.get(
        `/api/v1/objects?type=file&q=${encodeURIComponent(fileName)}&limit=1`,
      )
      const fileId = (await found.json()).items?.[0]?.id
      if (!fileId) throw new Error('загруженный файл не найден через API')
      await page.goto(`/o/${fileId}`)
      await page.getByRole('tab', { name: new RegExp(fileName) }).waitFor({ timeout: 20_000 })
      // Превью — изображение по подписанной ссылке S3 (img-src); его делает движок
      const enginePort = envValue('ENGINE_PORT') ?? '8000'
      const engineUp = await fetch(`http://localhost:${enginePort}/health`)
        .then((response) => response.ok)
        .catch(() => false)
      if (engineUp) {
        await page.locator(`img[src^="${s3Origin}"]`).first().waitFor({ timeout: 30_000 })
      } else {
        warnings.push('движок не запущен: превью не формируется, img-src S3 не проверен')
      }
      for (const tab of ['Связи', 'Обсуждение', 'Активность', 'Инфо']) {
        await page.getByRole('button', { name: tab, exact: true }).click()
        await page.waitForTimeout(200)
      }
      // Подсказки тегов — поповер со списком
      await page.getByRole('combobox', { name: 'Теги' }).fill('а')
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape')
    },
    state,
  )

  await step(
    'разделение панелей и перетаскивание границы',
    async () => {
      await page.goto('/')
      await page
        .getByRole('tab', { name: /Мой день/ })
        .first()
        .waitFor({ timeout: 20_000 })
      await page.keyboard.press('Meta+\\')
      const handle = page.locator('[data-panel-resize-handle-id]').first()
      await handle.waitFor({ state: 'visible' })
      // Новая панель перерисовывается (связь с исходной) — граница успокаивается не сразу
      let box = null
      for (let attempt = 0; attempt < 10 && !box; attempt++) {
        box = await handle.boundingBox()
        if (!box) await page.waitForTimeout(200)
      }
      if (!box) throw new Error('нет границы панелей')
      // Перетаскивание включает глобальный курсор — react-resizable-panels вставляет <style>
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 5 })
      await page.mouse.up()
    },
    state,
  )

  await step(
    'администрирование: все разделы',
    async () => {
      await palette('Администрирование')
      for (const section of ['Пользователи', 'Оргструктура', 'Аудит', 'Безопасность']) {
        // Разделы консоли — вкладки (TabsList «Разделы администрирования»)
        await page.getByRole('tab', { name: section }).click()
        await page.waitForTimeout(300)
      }
    },
    state,
  )

  // Экраны фазы 2 (ADR-0072, ADR-0070, ADR-0078): карта MapLibre с воркером и
  // тайлами, совместная правка тетради по WebSocket, предпросмотр печати отчёта.
  // Данные — по API в пространстве администратора: в CI демо-слоёв нет
  const run = Date.now().toString(36)
  const api = async (method, url, data) => {
    const me = await page.request.get('/api/v1/me')
    const csrf = (await me.json()).session.csrfToken
    const response = await page.request.fetch(url, {
      method,
      data,
      headers: { 'x-csrf-token': csrf },
    })
    if (!response.ok()) {
      throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`)
    }
    return response.json()
  }
  let gis = null
  await step(
    'карта: MapLibre, воркер, подложка и векторные тайлы',
    async () => {
      const spaces = (await (await page.request.get('/api/v1/spaces')).json()).items ?? []
      const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id
      if (!spaceId) throw new Error('нет пространства для данных карты')
      const dataset = await api('POST', '/api/v1/datasets', {
        name: `CSP точки ${run}`,
        spaceId,
        fields: [
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
        ],
      })
      await api('POST', `/api/v1/datasets/${dataset.id}/rows`, {
        rows: [
          { values: { name: 'Душанбе', place: { type: 'Point', coordinates: [68.78, 38.56] } } },
        ],
      })
      const layer = await api('POST', '/api/v1/gis/layers', {
        name: `CSP слой ${run}`,
        spaceId,
        datasetId: dataset.id,
      })
      const map = await api('POST', '/api/v1/gis/maps', {
        name: `CSP карта ${run}`,
        spaceId,
        spec: { layers: [{ layerId: layer.id }], camera: { center: [68.78, 38.56], zoom: 10 } },
      })
      gis = { spaceId, mapId: map.id }
      await page.goto(`/o/${map.id}`)
      // idle — стиль, воркер и тайлы загружены и нарисованы; failed — карта не поднялась
      await page.locator('[data-map-state="idle"]').first().waitFor({ timeout: 45_000 })
    },
    state,
  )

  await step(
    'тетрадь: совместная правка по WebSocket',
    async () => {
      if (!gis) throw new Error('нет пространства предыдущего шага')
      const notebook = await api('POST', '/api/v1/notebooks', {
        name: `CSP тетрадь ${run}`,
        spaceId: gis.spaceId,
        cells: [
          { id: 'intro', kind: 'text', body: { type: 'doc', content: [{ type: 'paragraph' }] } },
        ],
      })
      await page.goto(`/o/${notebook.id}`)
      await page.getByText('Все изменения сохранены').waitFor({ timeout: 20_000 })
    },
    state,
  )

  await step(
    'предпросмотр печати отчёта с картой',
    async () => {
      if (!gis) throw new Error('нет карты предыдущего шага')
      const report = await api('POST', '/api/v1/reports', {
        name: `CSP отчёт ${run}`,
        spaceId: gis.spaceId,
        blocks: [
          {
            id: 'title',
            kind: 'text',
            body: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Проверка CSP' }] }],
            },
          },
          { id: 'map', kind: 'map', mapId: gis.mapId },
        ],
      })
      await page.goto(`/print/report-preview/${report.id}`)
      await page.locator('html[data-print-state="ready"]').waitFor({ timeout: 60_000 })
    },
    state,
  )

  await step(
    'профиль и подсказки',
    async () => {
      await page.goto('/profile')
      await page.getByText('Двухфакторная аутентификация').first().waitFor({ timeout: 15_000 })
      await page.getByRole('navigation').first().getByRole('button').first().hover()
      await page.waitForTimeout(600)
    },
    state,
  )

  await step(
    'шпаргалка горячих клавиш',
    async () => {
      await page.goto('/')
      await page
        .getByRole('tab', { name: /Мой день/ })
        .first()
        .waitFor({ timeout: 20_000 })
      // Горячие клавиши работают, когда оболочка полностью загружена
      await page.getByText('На связи').waitFor({ timeout: 15_000 })
      await page.keyboard.press('Shift+?')
      await page.getByRole('dialog').getByText('Горячие клавиши').waitFor()
      await page.keyboard.press('Escape')
    },
    state,
  )

  await step(
    'тёмная тема до первой отрисовки (theme-init.js)',
    async () => {
      await palette('Тёмная')
      await page.locator('html[data-theme="dark"]').waitFor({ state: 'attached' })
      await page.reload()
      // Атрибут ставит внешний theme-init.js до загрузки приложения
      const early = await page.evaluate(() => document.documentElement.dataset.theme)
      if (early !== 'dark') throw new Error(`после перезагрузки тема «${early}»`)
      await page
        .getByRole('tab', { name: /Мой день/ })
        .first()
        .waitFor({ timeout: 20_000 })
      await palette('Светлая')
    },
    state,
  )

  await context.close()
}

async function main() {
  const skipBuild = process.argv.includes('--no-build')
  if (!skipBuild) {
    log('Сборка web…')
    execFileSync('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], {
      cwd: WEB,
      stdio: 'inherit',
    })
  }
  if (!existsSync(path.join(DIST, 'index.html'))) throw new Error('нет dist — соберите web')
  checkBuiltHtml()

  const s3Origin = storageOrigin()
  rmSync(SHOTS, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  docker(['rm', '-f', CONTAINER], { stdio: 'ignore' })
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    CONTAINER,
    '-p',
    `127.0.0.1:${PORT}:${PORT}`,
    '--add-host=host.docker.internal:host-gateway',
    '-v',
    `${CADDYFILE}:/etc/caddy/Caddyfile:ro`,
    '-v',
    `${DIST}:/srv/web:ro`,
    '-e',
    `KCHS_DOMAIN=:${PORT}`,
    '-e',
    `KCHS_API_UPSTREAM=${API_UPSTREAM}`,
    '-e',
    `KCHS_STORAGE_ORIGIN=${s3Origin}`,
    CADDY_IMAGE,
  ])

  let browser
  try {
    await waitForServer()
    log(`Caddy с продакшен-CSP: ${BASE} (S3: ${s3Origin})`)
    await checkNonce()

    const storageFile = path.join(mkdtempSync(path.join(tmpdir(), 'kchs-csp-')), 'admin.json')
    await signIn(storageFile)
    browser = await chromium.launch()
    await crawl(browser, storageFile, s3Origin)
  } finally {
    await browser?.close()
    docker(['rm', '-f', CONTAINER], { stdio: 'ignore' })
  }

  const unique = new Map()
  for (const violation of violations) {
    const key = `${violation.where}|${violation.directive}|${violation.blocked}|${violation.source}:${violation.line}`
    if (!unique.has(key)) unique.set(key, violation)
  }
  for (const violation of unique.values()) {
    log(
      `✗ CSP ${violation.directive}: заблокировано ${violation.blocked || '(inline)'} ` +
        `— ${violation.source ?? '?'}:${violation.line ?? '?'} [${violation.where}]` +
        (violation.sample ? ` «${violation.sample}»` : ''),
    )
  }
  for (const failure of failures) log(`✗ ${failure}`)
  for (const warning of warnings) log(`! ${warning}`)
  if (unique.size > 0 || failures.length > 0) {
    log(`Нарушений CSP: ${unique.size}, несработавших шагов: ${failures.length}`)
    process.exit(1)
  }
  log('CSP: нарушений нет')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
  docker(['rm', '-f', CONTAINER], { stdio: 'ignore' })
  process.exit(1)
})
