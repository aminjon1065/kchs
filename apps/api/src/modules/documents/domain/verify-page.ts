import { randomUUID } from 'node:crypto'
import {
  type Locale,
  type QualifiedCertificate,
  type QualifiedValidation,
  qualifiedValid,
} from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import { createTranslator } from '@kchs/i18n'
import { asc, eq } from 'drizzle-orm'
import { directory } from '~/kernel/directory/port.js'
import { BrandingService } from '~/kernel/settings/branding.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { documentSignatures, documents, documentTypes, documentVersions } from '../schema.js'
import { html, SafeHtml } from './print/html.js'

/**
 * Состояние подписи на странице проверки: верна, считается, не сходится, не найдена;
 * квалифицированная — ещё и «не прошла проверку» (цепочка, отзыв, целостность, ADR-0205).
 */
export type VerifyState = 'valid' | 'pending' | 'mismatch' | 'not_found' | 'invalid'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Язык страницы по заголовку браузера: таджикский, русский, английский; иначе русский. */
export function verifyLocale(acceptLanguage: string | undefined): Locale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.trim().slice(0, 2).toLowerCase()
    if (tag === 'tg' || tag === 'ru' || tag === 'en') return tag
  }
  return 'ru'
}

const CSS = `
:root { color-scheme: light; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  background: #f5f6f8; color: #1b1f24; }
main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
.org { font-size: 14px; color: #4a5361; margin: 0 0 4px; }
h1 { font-size: 22px; margin: 0 0 16px; }
.state { border-radius: 10px; padding: 14px 16px; margin: 0 0 20px; font-weight: 600; }
.valid { background: #e6f4ea; color: #1e5e2e; }
.pending { background: #fff4d6; color: #6b4e00; }
.mismatch, .not_found, .invalid { background: #fde8e8; color: #8a1c1c; }
section { background: #fff; border-radius: 10px; padding: 12px 16px; margin: 0 0 12px;
  box-shadow: 0 1px 2px rgba(0,0,0,.06); }
dl { margin: 0; display: grid; grid-template-columns: minmax(120px, 40%) 1fr; gap: 6px 12px; }
dt { color: #4a5361; }
dd { margin: 0; word-break: break-word; }
.hash { font-family: ui-monospace, 'DejaVu Sans Mono', monospace; font-size: 13px; }
.note { font-size: 13px; color: #4a5361; }
`

interface VerifyRow {
  id: string
  documentId: string
  versionId: string | null
  signerId: string
  actorId: string | null
  signedAt: string
  hash: string | null
  manifest: Record<string, unknown> | null
  mfa: boolean
  kind: string
  certificate: Record<string, unknown> | null
  validation: Record<string, unknown> | null
}

function stateOf(
  row: Pick<VerifyRow, 'hash' | 'manifest' | 'kind' | 'validation'>,
  version: { hash: string | null; manifestHash: string | null } | undefined,
): VerifyState {
  // КЭП: проверка движком — целостность PDF, цепочка до корня УЦ, отзыв
  if (
    row.kind === 'qualified' &&
    row.validation &&
    !qualifiedValid(row.validation as unknown as QualifiedValidation)
  ) {
    return 'invalid'
  }
  const expected = row.manifest ? version?.manifestHash : version?.hash
  if (!row.hash || !expected) return 'pending'
  return row.hash === expected ? 'valid' : 'mismatch'
}

function stateText(t: (key: string) => string, state: VerifyState): string {
  return state === 'invalid' ? t('documents.verify.invalid') : t(`documents.verify.state.${state}`)
}

/** Сертификат и проверка КЭП: владелец, номер, срок, издатель, отзыв, штамп времени. */
function qualifiedRows(
  item: VerifyRow,
  t: (key: string, values?: Record<string, string>) => string,
  locale: Locale,
  timezone: string,
): SafeHtml | string {
  if (item.kind !== 'qualified' || !item.certificate) return ''
  const certificate = item.certificate as unknown as QualifiedCertificate
  const validation = item.validation as unknown as QualifiedValidation | null
  return html`<dt>${t('documents.verify.owner')}</dt><dd>${certificate.owner}${
    certificate.organization ? html`, ${certificate.organization}` : ''
  }</dd>
  <dt>${t('documents.verify.certificate')}</dt><dd class="hash">${certificate.serial.toUpperCase()}</dd>
  <dt>${t('documents.verify.validity')}</dt><dd>${t('documents.verify.validityRange', {
    from: formatDate(certificate.notBefore, { locale, timezone }),
    to: formatDate(certificate.notAfter, { locale, timezone }),
  })}</dd>
  <dt>${t('documents.verify.issuer')}</dt><dd>${certificate.issuer}</dd>
  ${
    validation
      ? html`<dt>${t('documents.verify.revocationLabel')}</dt><dd>${t(`documents.verify.revocation.${validation.revocation}`)}</dd>
  <dt>${t('documents.verify.timestamp')}</dt><dd>${
    validation.timestampAt ? formatDateTime(validation.timestampAt, { locale, timezone }) : '—'
  }</dd>`
      : ''
  }`
}

/**
 * Страница проверки подписи по QR (ADR-0198): серверный HTML без скриптов, без
 * входа. Видно, кто, когда и что подписал по реквизитам, и сходится ли подпись
 * с версией; содержания, темы и файлов нет. У документа «Конфиденциально» —
 * только состояние.
 */
export async function renderVerifyPage(
  signatureId: string,
  acceptLanguage: string | undefined,
): Promise<{ status: number; body: string; nonce: string }> {
  const locale = verifyLocale(acceptLanguage)
  const t = createTranslator(locale)
  const nonce = randomUUID()
  const organization = (await BrandingService.current()).name
  const page = (status: number, content: SafeHtml) => ({
    status,
    nonce,
    body: html`<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${t('documents.verify.title')}</title>
<style nonce="${nonce}">${new SafeHtml(CSS)}</style>
</head>
<body><main>
<p class="org">${organization}</p>
<h1>${t('documents.verify.title')}</h1>
${content}
<p class="note">${t('documents.verify.note')}</p>
</main></body>
</html>`.value,
  })

  const row = UUID.test(signatureId)
    ? (
        await db()
          .select({
            id: documentSignatures.id,
            documentId: documentSignatures.documentId,
            versionId: documentSignatures.versionId,
            signerId: documentSignatures.signerId,
            actorId: documentSignatures.actorId,
            signedAt: documentSignatures.signedAt,
            hash: documentSignatures.hash,
            manifest: documentSignatures.manifest,
            mfa: documentSignatures.mfa,
            kind: documentSignatures.kind,
            certificate: documentSignatures.certificate,
            validation: documentSignatures.validation,
          })
          .from(documentSignatures)
          .where(eq(documentSignatures.id, signatureId))
          .limit(1)
      )[0]
    : undefined
  if (!row) {
    return page(
      404,
      html`<div class="state not_found">${t('documents.verify.state.not_found')}</div>`,
    )
  }

  const [doc] = await db()
    .select({
      regNumber: documents.regNumber,
      regDate: documents.regDate,
      confidentiality: documents.confidentiality,
      typeName: documentTypes.name,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
    .where(eq(documents.id, row.documentId))
    .limit(1)
  const siblings: VerifyRow[] = row.versionId
    ? await db()
        .select({
          id: documentSignatures.id,
          documentId: documentSignatures.documentId,
          versionId: documentSignatures.versionId,
          signerId: documentSignatures.signerId,
          actorId: documentSignatures.actorId,
          signedAt: documentSignatures.signedAt,
          hash: documentSignatures.hash,
          manifest: documentSignatures.manifest,
          mfa: documentSignatures.mfa,
          kind: documentSignatures.kind,
          certificate: documentSignatures.certificate,
          validation: documentSignatures.validation,
        })
        .from(documentSignatures)
        .where(eq(documentSignatures.versionId, row.versionId))
        .orderBy(asc(documentSignatures.signedAt))
    : [row]
  const [version] = row.versionId
    ? await db()
        .select({
          number: documentVersions.number,
          hash: documentVersions.hash,
          manifestHash: documentVersions.manifestHash,
        })
        .from(documentVersions)
        .where(eq(documentVersions.id, row.versionId))
        .limit(1)
    : []
  const state = stateOf(row, version)
  const banner = html`<div class="state ${state}">${stateText(t, state)}</div>`
  // Конфиденциальный документ — только состояние подписи: даже реквизиты не раскрываем
  if (doc?.confidentiality === 'confidential') return page(200, banner)

  const people = await directory().refs([
    ...new Set(siblings.flatMap((item) => [item.signerId, item.actorId ?? item.signerId])),
  ])
  const name = (id: string) => {
    const ref = people.get(id)
    return ref ? (ref.position ? `${ref.displayName}, ${ref.position}` : ref.displayName) : '—'
  }
  const timezone = config().TZ
  const typeName = doc ? (doc.typeName[locale] ?? doc.typeName.ru ?? '') : ''
  return page(
    200,
    html`${banner}
<section><dl>
  <dt>${t('documents.verify.document')}</dt><dd>${typeName}</dd>
  ${
    doc?.regNumber
      ? html`<dt>${t('documents.verify.number')}</dt><dd>${doc.regNumber}${
          doc.regDate ? html` · ${formatDate(doc.regDate, { locale, timezone: 'UTC' })}` : ''
        }</dd>`
      : ''
  }
  ${version ? html`<dt>${t('documents.verify.version')}</dt><dd>${version.number}</dd>` : ''}
</dl></section>
${siblings.map(
  (item) => html`<section><dl>
  <dt>${t('documents.verify.signer')}</dt><dd>${name(item.signerId)}</dd>
  ${
    item.actorId && item.actorId !== item.signerId
      ? html`<dt>${t('documents.verify.actor')}</dt><dd>${name(item.actorId)}</dd>`
      : ''
  }
  <dt>${t('documents.verify.signedAt')}</dt><dd>${formatDateTime(item.signedAt, { locale, timezone })}</dd>
  <dt>${t('documents.verify.kind')}</dt><dd>${t(`documents.verify.kinds.${item.kind === 'qualified' ? 'qualified' : 'simple'}`)}${
    item.mfa ? html` · ${t('documents.verify.mfa')}` : ''
  }</dd>
  <dt>${t('documents.verify.state.label')}</dt><dd>${stateText(t, stateOf(item, version))}</dd>
  ${qualifiedRows(item, t, locale, timezone)}
  <dt>SHA-256</dt><dd class="hash">${item.hash ?? '—'}</dd>
</dl></section>`,
)}`,
  )
}
