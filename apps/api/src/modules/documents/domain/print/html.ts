/**
 * HTML печатных форм (ADR-0085). Разметку собирает api, Chromium движка только
 * печатает её: подстановки шаблонной строки `html` экранируются всегда, как
 * есть вставляются лишь фрагменты, собранные той же `html` (`SafeHtml`).
 * Внешних ресурсов нет — движок и так блокирует сеть страницы печати.
 */

/** Фрагмент разметки, уже безопасный для вставки. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value
  }
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char)
}

function part(value: unknown): string {
  if (value instanceof SafeHtml) return value.value
  if (Array.isArray(value)) return value.map(part).join('')
  if (value === null || value === undefined || value === false) return ''
  return escapeHtml(value)
}

/** Разметка с экранированием подстановок; массивы фрагментов склеиваются. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let result = strings[0] ?? ''
  values.forEach((value, index) => {
    result += part(value) + (strings[index + 1] ?? '')
  })
  return new SafeHtml(result)
}

/** Перенос строк текста — `<br>`, остальное экранируется. */
export function multiline(value: string | null | undefined): SafeHtml {
  return new SafeHtml(
    String(value ?? '')
      .split(/\r?\n/)
      .map(escapeHtml)
      .join('<br>'),
  )
}

/**
 * Стили форм: шрифты образа движка (Liberation — метрики Times New Roman и
 * Arial, DejaVu — запасной с таджикскими буквами), 12 pt, чёрный по белому.
 */
const PRINT_CSS = `
html { font-family: 'Liberation Serif', 'DejaVu Serif', serif; font-size: 12pt; color: #000; }
body { margin: 0; }
h1 { font-size: 14pt; font-weight: bold; text-align: center; text-transform: uppercase; margin: 0 0 2mm; }
.subtitle { text-align: center; margin: 0 0 7mm; }
.org { text-align: center; font-weight: bold; margin: 0 0 6mm; }
.muted { color: #444; }
.small { font-size: 10pt; }
table { border-collapse: collapse; width: 100%; }
table.card th { width: 38%; text-align: left; font-weight: normal; color: #333; vertical-align: top;
  padding: 1.6mm 3mm 1.6mm 0; border-bottom: 0.4pt solid #999; }
table.card td { vertical-align: top; padding: 1.6mm 0; border-bottom: 0.4pt solid #999; }
table.grid { font-size: 10pt; }
table.grid th, table.grid td { border: 0.6pt solid #000; padding: 1.4mm 1.8mm; vertical-align: top; text-align: left; }
table.grid th { font-weight: bold; background: #f2f2f2; }
table.grid thead { display: table-header-group; }
table.grid tr { page-break-inside: avoid; }
.num { text-align: right; white-space: nowrap; }
.mono { font-family: 'DejaVu Sans Mono', monospace; font-size: 10pt; }
.signatures { margin-top: 12mm; display: flex; justify-content: space-between; gap: 10mm; }
.signature { flex: 1; border-top: 0.6pt solid #000; padding-top: 1mm; font-size: 9pt; color: #333; }
.section { margin: 6mm 0 2mm; font-weight: bold; }
`

/** Страница печатной формы: движок печатает её на A4 с колонтитулом и номерами листов. */
export function printPage(input: { title: string; lang: string; body: SafeHtml }): string {
  return html`<!doctype html>
<html lang="${input.lang}">
<head><meta charset="utf-8"><title>${input.title}</title><style>${new SafeHtml(PRINT_CSS)}</style></head>
<body>${input.body}</body>
</html>`.value
}

/**
 * Страница наложения (штамп, водяной знак) того же размера, что лист PDF:
 * фон прозрачный, всё содержимое — абсолютно позиционированные блоки.
 */
export function overlayPage(input: { lang: string; css: string; body: SafeHtml }): string {
  return html`<!doctype html>
<html lang="${input.lang}">
<head><meta charset="utf-8"><style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; }
body { position: relative; overflow: hidden; font-family: 'Liberation Serif', 'DejaVu Serif', serif; }
${new SafeHtml(input.css)}
</style></head>
<body>${input.body}</body>
</html>`.value
}
