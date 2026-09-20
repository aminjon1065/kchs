/**
 * Публичная документация API на `/api/docs` (14-automation-integrations.md §3,
 * ADR-0097).
 *
 * Страница собирается на сервере из того же OpenAPI, что отдаёт
 * `/api/openapi.json`: без скриптов и внешних библиотек. Это не прихоть —
 * CSP установки разрешает только свои файлы (`script-src 'self'`,
 * `style-src 'self' 'nonce-…'`, ADR-0043), а nonce Caddy подставляет лишь в
 * `index.html` SPA. Раскрытие разделов делает `<details>` браузера.
 */

/**
 * Разделы OpenAPI: порядок и человеческие описания групп. Тег маршрута — это
 * ещё и ресурс области доступа токена (ADR-0097), поэтому список один.
 */
export const OPENAPI_TAGS = [
  { name: 'auth', description: 'Вход, второй фактор, сессии' },
  { name: 'me', description: 'Профиль, настройки, устройства, токены API' },
  { name: 'objects', description: 'Реестр объектов: карточка, связи, активность, права' },
  { name: 'access', description: 'Права объекта, ссылки на объект, «объяснить доступ»' },
  { name: 'spaces', description: 'Пространства и их участники' },
  { name: 'org', description: 'Пользователи, подразделения, группы, роли' },
  { name: 'data', description: 'Датасеты, строки, запросы, показатели, графики, дашборды' },
  { name: 'gis', description: 'Слои, карты, тайлы, территории, анализ' },
  { name: 'documents', description: 'Документы, типы, журналы, версии, дела' },
  { name: 'tasks', description: 'Задачи, поручения, проекты' },
  { name: 'files', description: 'Файлы, папки, версии, превью' },
  { name: 'reports', description: 'Отчёты и их выпуски' },
  { name: 'calendar', description: 'Календари, события, приглашения' },
  { name: 'business-calendar', description: 'Производственный календарь: рабочие и праздничные дни' },
  { name: 'meetings', description: 'Встречи, комнаты, записи, протоколы' },
  { name: 'chat', description: 'Беседы и сообщения' },
  { name: 'discussions', description: 'Обсуждение объекта' },
  { name: 'processes', description: 'Маршруты: определения и экземпляры' },
  { name: 'search', description: 'Поиск по объектам' },
  { name: 'notifications', description: 'Уведомления и настройки доставки' },
  { name: 'inbox', description: 'Входящие: дела, решения, откладывание' },
  { name: 'jobs', description: 'Задания: состояние длительных операций' },
  { name: 'views', description: 'Сохранённые представления списков' },
  { name: 'tags', description: 'Метки' },
  { name: 'acknowledgments', description: 'Ознакомление с документами и страницами' },
  { name: 'announcements', description: 'Объявления установки' },
  { name: 'ai', description: 'Интеллектуальные функции; токенам API недоступны' },
  { name: 'integrations', description: 'Интеграции, исходящие и входящие вебхуки' },
  { name: 'admin', description: 'Администрирование: аудит, здоровье, токены, конфигурация' },
  {
    name: 'internal',
    description:
      'Служебные маршруты движка: доступны только внутри сети развёртывания, ' +
      'снаружи прокси отвечает 404',
  },
] as const

interface Operation {
  method: string
  path: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>
  requestBody?: unknown
  responses?: Record<string, { description?: string }>
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function operations(spec: Record<string, unknown>): Operation[] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>
  const list: Operation[] = []
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = item[method] as Operation | undefined
      if (!operation) continue
      list.push({ ...operation, method: method.toUpperCase(), path })
    }
  }
  return list
}

function group(list: Operation[]): Map<string, Operation[]> {
  const byTag = new Map<string, Operation[]>()
  for (const operation of list) {
    const tag = operation.tags?.[0] ?? 'прочее'
    byTag.set(tag, [...(byTag.get(tag) ?? []), operation])
  }
  return new Map(
    [...byTag.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'ru'))
      .map(([tag, items]) => [
        tag,
        items.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
      ]),
  )
}

function renderOperation(operation: Operation): string {
  const params = (operation.parameters ?? []).filter((p) => p.in !== 'header')
  const responses = Object.keys(operation.responses ?? {}).sort()
  return `<details class="op">
  <summary><span class="m m-${operation.method.toLowerCase()}">${operation.method}</span>
  <code>${escapeHtml(operation.path)}</code>
  <span class="sum">${escapeHtml(operation.summary ?? '')}</span></summary>
  ${operation.description ? `<p>${escapeHtml(operation.description)}</p>` : ''}
  ${
    params.length > 0
      ? `<p class="lbl">Параметры</p><ul>${params
          .map(
            (p) =>
              `<li><code>${escapeHtml(p.name)}</code> <i>(${escapeHtml(p.in)}${
                p.required ? ', обязателен' : ''
              })</i>${p.description ? ` — ${escapeHtml(p.description)}` : ''}</li>`,
          )
          .join('')}</ul>`
      : ''
  }
  ${operation.requestBody ? '<p class="lbl">Тело запроса: <code>application/json</code></p>' : ''}
  ${
    responses.length > 0
      ? `<p class="lbl">Ответы</p><ul>${responses
          .map(
            (code) =>
              `<li><code>${escapeHtml(code)}</code>${
                operation.responses?.[code]?.description
                  ? ` — ${escapeHtml(operation.responses[code].description ?? '')}`
                  : ''
              }</li>`,
          )
          .join('')}</ul>`
      : ''
  }
</details>`
}

const INTRO = `
<h2 id="auth">Аутентификация</h2>
<p>Браузер работает по cookie-сессии с заголовком <code>X-CSRF-Token</code>.
Интеграция предъявляет токен: <code>Authorization: Bearer kchs_…</code>. Токен не расширяет
прав человека, которому принадлежит: сначала проверяется область доступа
(<code>read:datasets</code>, <code>write:documents</code>…), затем обычная проверка прав на объект.
Токен выпускается в профиле («Мои токены») и показывается один раз.</p>
<h2 id="conventions">Соглашения</h2>
<ul>
  <li>База — <code>/api/v1</code>, JSON в UTF-8, идентификаторы — UUID v7.</li>
  <li>Списки — курсорная пагинация: <code>?cursor=&amp;limit=</code>, ответ <code>{items, nextCursor}</code>.</li>
  <li>Конкурентность — <code>If-Match: &lt;version&gt;</code>, конфликт — <code>409</code>.</li>
  <li>Повторная отправка — <code>Idempotency-Key</code> у <code>POST</code>.</li>
  <li>Ошибки — <code>application/problem+json</code> с полем <code>code</code>.</li>
  <li>Лимит запросов — <code>429</code> с заголовком <code>Retry-After</code>; у токена свой счётчик.</li>
</ul>
<h2 id="batch">Массовые и длительные операции</h2>
<ul>
  <li><code>POST /objects/batch-get</code> — сводки до 200 объектов одним запросом; недоступные
  приходят с <code>accessible: false</code> и пустым названием.</li>
  <li><code>POST /datasets/{id}/rows/batch</code> — вставка, изменение и удаление строк одним
  запросом. Большая пачка выполняется заданием: ответ <code>202</code> с <code>{jobId}</code>,
  состояние — <code>GET /jobs/{jobId}</code>.</li>
  <li>Выгрузки и анализы возвращают <code>{jobId}</code>; прогресс приходит по WebSocket.</li>
</ul>
<h2 id="webhooks">Вебхуки</h2>
<p>Исходящий вебхук отправляет <code>POST</code> с конвертом события. Заголовки:
<code>x-kchs-event</code>, <code>x-kchs-delivery</code>, <code>x-kchs-timestamp</code>,
<code>x-kchs-signature</code>. Подпись — <code>sha256=HMAC-SHA256(секрет, "&lt;timestamp&gt;.&lt;тело&gt;")</code>.
Ответ 2xx считается доставкой; иначе повторы с нарастающей задержкой до суток.</p>
<p>Входящий вебхук — <code>POST /api/v1/hooks/{integrationId}/{secret}</code>: публикует событие
<code>webhook.received</code>, ничего не меняя; действия выполняют правила автоматизации.</p>
`

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1a1d21;--muted:#5b6470;--line:#e3e6ea;--code:#f4f6f8}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e8ebed;--muted:#98a2ad;--line:#2a2f35;--code:#1d2126}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
main{max-width:56rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:1.6rem;margin:0 0 .25rem}
h2{font-size:1.15rem;margin:2rem 0 .5rem;padding-top:.5rem;border-top:1px solid var(--line)}
h3{font-size:1rem;margin:1.5rem 0 .5rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
p,li{color:var(--fg)}
code{background:var(--code);border-radius:4px;padding:.1em .35em;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:inherit}
.lead{color:var(--muted)}
.op{border:1px solid var(--line);border-radius:8px;margin:.4rem 0;background:var(--bg)}
.op>summary{cursor:pointer;padding:.55rem .75rem;display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
.op[open]>summary{border-bottom:1px solid var(--line)}
.op p,.op ul{margin:.5rem .75rem}
.m{font:600 11px/1.6 ui-monospace,monospace;letter-spacing:.06em;padding:.05rem .4rem;border-radius:4px;border:1px solid var(--line)}
.m-get{color:#0a6b3d}.m-post{color:#1b4fa0}.m-patch{color:#8a5a00}.m-put{color:#8a5a00}.m-delete{color:#9b1c1c}
@media (prefers-color-scheme:dark){.m-get{color:#5ed99a}.m-post{color:#7fb2ff}.m-patch{color:#ffc46b}.m-put{color:#ffc46b}.m-delete{color:#ff8f8f}}
.sum{color:var(--muted);font-size:.9em}
.lbl{font-weight:600;margin-bottom:.15rem}
nav{margin:.75rem 0 0}
nav a{margin-right:.75rem;font-size:.9em;color:var(--muted)}`

/** Собирает страницу документации из спецификации OpenAPI. */
export function renderApiDocs(spec: Record<string, unknown>): string {
  const info = (spec.info ?? {}) as { title?: string; version?: string; description?: string }
  const byTag = group(operations(spec))
  const sections = [...byTag.entries()]
    .map(
      ([tag, items]) =>
        `<h3 id="tag-${escapeHtml(tag)}">${escapeHtml(tag)} <span class="sum">(${items.length})</span></h3>${items
          .map(renderOperation)
          .join('')}`,
    )
    .join('')
  const nav = [...byTag.keys()]
    .map((tag) => `<a href="#tag-${escapeHtml(tag)}">${escapeHtml(tag)}</a>`)
    .join('')

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(info.title ?? 'API')} — документация</title>
<link rel="stylesheet" href="/api/docs/style.css">
</head>
<body>
<main>
<h1>${escapeHtml(info.title ?? 'API')} <span class="sum">${escapeHtml(info.version ?? '')}</span></h1>
<p class="lead">${escapeHtml(info.description ?? '')}</p>
<p class="lead">Машиночитаемая спецификация — <a href="/api/openapi.json">/api/openapi.json</a>.</p>
${INTRO}
<h2 id="ops">Маршруты</h2>
<nav>${nav}</nav>
${sections}
</main>
</body>
</html>`
}

export const API_DOCS_STYLE = STYLE
