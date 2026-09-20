import type { OfficeDocumentType } from '@kchs/contracts'
import { officeFormat } from '@kchs/contracts'

/**
 * Страница редактора (ADR-0112). Скрипт сервера документов — посторонний код,
 * поэтому он живёт не в приложении, а на отдельной странице, у которой своя
 * политика CSP: `default-src 'none'`, а единственный названный источник —
 * сервер документов. `connect-src` не содержит `'self'`, так что до API
 * платформы этот скрипт не дотянется, а рабочая область вставляет страницу
 * кадром `sandbox` без права уводить вкладку и открывать окна.
 *
 * Непрозрачное происхождение (`sandbox` без `allow-same-origin`) было бы
 * строже, но флаги песочницы наследуются вложенными кадрами: редактор сервера
 * документов — тоже кадр, и его собственные запросы к своему же происхождению
 * начинают считаться межсайтовыми. Проверено на ONLYOFFICE 9.4: редактор при
 * этом не открывается вовсе.
 *
 * Обратная связь кадра — `postMessage`; родитель узнаёт свой кадр по
 * `event.source` и показывает состояние вкладки по его сообщениям.
 */

export interface OfficeEditorInput {
  title: string
  documentType: OfficeDocumentType
  documentKey: string
  fileName: string
  contentUrl: string
  callbackUrl: string | null
  mode: 'edit' | 'view'
  lang: string
  user: { id: string; name: string }
}

export interface OfficePageInput extends OfficeEditorInput {
  serverUrl: string
  /** Одноразовый nonce: единственный способ выполнить наш скрипт на странице. */
  nonce: string
  failedText: string
  /** Подпись конфигурации общим секретом — её проверяет сервер документов. */
  token: string
}

/** Значение внутрь `<script type="application/json">`: разрыв тега исключён. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028|\u2029/g, '')
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Конфигурация редактора по протоколу сервера документов. Подписывается
 * целиком: подменённые права или чужой адрес содержимого сервер не примет.
 */
export function officeEditorConfig(input: OfficeEditorInput) {
  const canEdit = input.mode === 'edit'
  return {
    document: {
      fileType: officeFormat(input.fileName) ?? 'docx',
      key: input.documentKey,
      title: input.fileName,
      url: input.contentUrl,
      permissions: {
        edit: canEdit,
        // Скачивание и печать идут своим путём — с проверкой грифа (ADR-0085)
        download: false,
        print: false,
        comment: canEdit,
        fillForms: canEdit,
        review: canEdit,
        copy: true,
      },
    },
    documentType: input.documentType,
    type: 'desktop',
    editorConfig: {
      mode: input.mode,
      lang: input.lang,
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
      user: input.user,
      customization: {
        autosave: true,
        forcesave: true,
        chat: false,
        comments: canEdit,
        help: false,
        plugins: false,
        compactHeader: true,
        hideRightMenu: true,
        // Чужого логотипа и ссылок наружу в рабочей области быть не должно
        logo: { image: '', imageDark: '', url: '' },
      },
    },
  }
}

/** Разметка страницы: скрипт сервера документов и один наш — под nonce. */
export function renderOfficePage(input: OfficePageInput): string {
  const config = {
    ...officeEditorConfig(input),
    token: input.token,
    width: '100%',
    height: '100%',
  }
  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
html, body { margin: 0; height: 100%; background: #f5f6f8; }
#editor { position: absolute; inset: 0; }
#failed {
  display: none; position: absolute; inset: 0; align-items: center; justify-content: center;
  font: 15px/1.5 system-ui, sans-serif; color: #4b5563; padding: 24px; text-align: center;
}
</style>
</head>
<body>
<div id="editor"></div>
<div id="failed">${escapeHtml(input.failedText)}</div>
<script type="application/json" id="kchs-office-config">${embedJson(config)}</script>
<script src="${escapeHtml(input.serverUrl)}/web-apps/apps/api/documents/api.js"></script>
<script nonce="${escapeHtml(input.nonce)}">${OFFICE_PAGE_SCRIPT}</script>
</body>
</html>`
}

/**
 * Скрипт страницы. Он только собирает редактор и пересказывает родителю его
 * события: «готов», «есть несохранённое», «сохранено», «ошибка». Родитель по
 * ним показывает состояние вкладки и понятное сообщение вместо белого экрана.
 */
const OFFICE_PAGE_SCRIPT = `(function () {
  var node = document.getElementById('kchs-office-config')
  var config = JSON.parse(node.textContent)
  function tell(kind, detail) {
    try {
      window.parent.postMessage({ source: 'kchs-office', kind: kind, detail: detail || null }, '*')
    } catch (error) {
      /* родитель мог закрыться раньше кадра */
    }
  }
  function fail() {
    document.getElementById('failed').style.display = 'flex'
    tell('unavailable')
  }
  if (typeof DocsAPI === 'undefined') return fail()
  config.events = {
    onAppReady: function () { tell('ready') },
    onDocumentStateChange: function (event) { tell(event && event.data ? 'dirty' : 'saved') },
    onRequestClose: function () { tell('close') },
    onError: function (event) {
      var data = event && event.data ? event.data : null
      tell('error', data ? String(data.errorDescription || data) : null)
    },
    onWarning: function (event) {
      var data = event && event.data ? event.data : null
      tell('warning', data ? String(data.warningDescription || '') : null)
    },
  }
  try {
    new DocsAPI.DocEditor('editor', config)
  } catch (error) {
    fail()
  }
})()`
