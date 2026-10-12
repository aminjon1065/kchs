import { randomUUID } from 'node:crypto'
import { QES_FAILURE_REASONS } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { qualifiedSignature } from '~/kernel/signature/port.js'
import { verifySigningTicket } from '~/kernel/signature/ticket.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { html, SafeHtml } from './print/html.js'
import { loadSubject } from './render-queue.js'
import { QualifiedSignatures } from './routes/qualified.js'

const CSS = `
:root { color-scheme: light; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  background: #f5f6f8; color: #1b1f24; }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 8px; }
.doc { color: #4a5361; margin: 0 0 20px; word-break: break-word; }
ol { padding-left: 20px; margin: 0 0 20px; color: #4a5361; }
.status { border-radius: 10px; padding: 14px 16px; margin: 0 0 12px; background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.06); font-weight: 600; }
.status.ok { background: #e6f4ea; color: #1e5e2e; }
.status.error { background: #fde8e8; color: #8a1c1c; }
.detail { font-size: 14px; color: #4a5361; min-height: 1.5em; margin: 0 0 16px; word-break: break-word; }
button { font: inherit; font-weight: 600; padding: 10px 20px; border-radius: 8px; border: 0;
  background: #1f5fbf; color: #fff; cursor: pointer; }
button:disabled { opacity: .55; cursor: default; }
.note { font-size: 13px; color: #4a5361; margin-top: 24px; }
`

/**
 * Скрипт страницы: агент УЦ выдаёт сертификат → api готовит PDF (движок) → агент
 * подписывает хэш → api встраивает и проверяет CMS. Адреса — только свой сеанс и
 * агент (CSP `connect-src`); билет — в адресе, cookie не отправляются.
 */
const SCRIPT = `(() => {
  const cfg = JSON.parse(document.getElementById('cfg').textContent)
  const el = (id) => document.getElementById(id)
  const query = '?t=' + encodeURIComponent(cfg.ticket)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let picked = null
  const show = (key, tone, detail) => {
    el('status').textContent = cfg.text[key] || key
    el('status').className = 'status' + (tone ? ' ' + tone : '')
    el('detail').textContent = detail || ''
  }
  async function api(path, body) {
    const response = await fetch(cfg.base + path + query, body
      ? { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { credentials: 'omit' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status))
    return data
  }
  async function agent(path, body) {
    let response
    try {
      response = await fetch(cfg.agentUrl + path, { method: 'POST', credentials: 'omit',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } catch (error) {
      throw new Error(cfg.text.agentMissing)
    }
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(cfg.text.agentFailed + (data.message ? ': ' + data.message : ''))
    return data
  }
  async function until(states) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const state = await api('/state')
      if (states.includes(state.state) || state.state === 'failed') return state
      await sleep(1500)
    }
    throw new Error(cfg.text.timeout)
  }
  function finish(state) {
    if (state.state === 'signed') {
      show('signed', 'ok', cfg.text.close)
      el('sign').hidden = true
      return true
    }
    if (state.state === 'failed') {
      show('failed', 'error', cfg.reasons[state.reason] || '')
      el('sign').hidden = true
      return true
    }
    return false
  }
  async function run() {
    el('sign').disabled = true
    try {
      let state = await api('/state')
      if (state.state === 'awaiting_certificate') {
        show('agentCertificate')
        picked = await agent('/v1/certificate', { purpose: 'sign' })
        show('preparing')
        state = await api('/certificate', { certificate: picked.certificate })
      }
      if (state.state === 'preparing') {
        show('preparing')
        state = await until(['awaiting_signature'])
      }
      if (state.state === 'awaiting_signature') {
        show('agentSign')
        const signed = await agent('/v1/sign', {
          format: 'cades-detached',
          digestAlgorithm: state.digestAlgorithm,
          digest: state.dataToSign,
          certificate: picked ? picked.certificate : null,
          certificateSha256: state.certificate ? state.certificate.fingerprint : null,
        })
        show('verifying')
        state = await api('/result', { cms: signed.cms })
      }
      if (state.state === 'verifying') {
        show('verifying')
        state = await until(['signed'])
      }
      if (finish(state)) return
    } catch (error) {
      show('error', 'error', error.message)
    }
    el('sign').disabled = false
  }
  el('sign').addEventListener('click', run)
  api('/state').then((state) => { if (!finish(state)) show('ready') })
    .catch((error) => show('error', 'error', error.message))
})()`

/** Безопасная вставка JSON в `<script type="application/json">`. */
function jsonData(value: unknown): SafeHtml {
  return new SafeHtml(
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029'),
  )
}

/**
 * Страница подписания (ADR-0205): серверный HTML со своим скриптом и своей CSP —
 * `connect-src` только агент УЦ и маршруты своего сеанса. Открывает её вошедший
 * подписант по ссылке из карточки; билет в адресе подписан api и открывает только
 * этот сеанс. Ключ подписи страница не видит: подписывает агент.
 */
export async function renderSigningPage(
  ctx: UserCtx,
  sessionId: string,
  ticket: unknown,
): Promise<{ body: string; csp: string }> {
  const claims = verifySigningTicket(ticket, sessionId)
  if (!claims || claims.userId !== ctx.userId) throw errors.notFound('Сеанс подписания')
  const row = await QualifiedSignatures.byTicket(sessionId, ticket)
  const authority = await qualifiedSignature().authority()
  if (!authority) {
    throw errors.conflict('Квалифицированная подпись не настроена', {
      reason: 'qualified_signature',
    })
  }
  const subject = await loadSubject(db(), row.documentId)
  const t = createTranslator(ctx.locale)
  const nonce = randomUUID()
  const base = `${config().KCHS_BASE_URL}/api/v1/qes/sessions/${sessionId}`
  const text = Object.fromEntries(
    [
      'ready',
      'agentCertificate',
      'preparing',
      'agentSign',
      'verifying',
      'signed',
      'failed',
      'error',
      'timeout',
      'agentFailed',
      'agentMissing',
      'close',
    ].map((key) => [key, t(`documents.qualified.page.${key}`)]),
  )
  const reasons = Object.fromEntries(
    QES_FAILURE_REASONS.map((key) => [key, t(`documents.qualified.reasons.${key}`)]),
  )
  const data = { base, ticket, agentUrl: authority.agentUrl, text, reasons }
  const body = html`<!doctype html>
<html lang="${ctx.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${t('documents.qualified.page.title')}</title>
<style nonce="${nonce}">${new SafeHtml(CSS)}</style>
</head>
<body><main>
<h1>${t('documents.qualified.page.title')}</h1>
<p class="doc">${subject?.title ?? ''}</p>
<ol>
  <li>${t('documents.qualified.page.stepCertificate')}</li>
  <li>${t('documents.qualified.page.stepSign')}</li>
  <li>${t('documents.qualified.page.stepVerify')}</li>
</ol>
<div id="status" class="status" role="status" aria-live="polite">${t('documents.qualified.page.loading')}</div>
<p id="detail" class="detail"></p>
<button id="sign" type="button">${t('documents.qualified.page.sign')}</button>
<p class="note">${t('documents.qualified.page.note')}</p>
<script id="cfg" type="application/json">${jsonData(data)}</script>
<script nonce="${nonce}">${new SafeHtml(SCRIPT)}</script>
</main></body>
</html>`.value
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    // Только агент УЦ на рабочем месте и маршруты своего сеанса
    `connect-src ${authority.agentUrl}/ ${base}/`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  return { body, csp }
}
