import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { UserService } from '~/modules/identity/public.js'
import { registerAllObjectTypes } from '~/modules/index.js'
import { Integrations } from '~/modules/integrations/public.js'
import { MailPublic } from '~/modules/mail/public.js'
import { config } from '~/shared/config/index.js'

/** Интеграция приёма ящика канцелярии своего почтового сервера. */
const INTAKE_KEY = 'mail-registry'

export interface MailSyncReport {
  enabled: boolean
  accounts: number
  created: number
  file: string | null
  registry: string | null
  intake: 'created' | 'exists' | 'skipped'
  intakeHint: string | null
}

async function firstWithRole(roleKey: string): Promise<string | null> {
  const page = await UserService.list({ roleKey, status: 'active', kind: 'person', limit: 1 })
  return page.items[0]?.id ?? null
}

/**
 * `kchs mail sync` (ADR-0150): ящики сотрудников и канцелярии → файл учёток почтового
 * сервера; приём в очередь «Из почты» из ящика канцелярии, если его ещё нет.
 */
export async function runMailSync(): Promise<MailSyncReport> {
  if (!MailPublic.enabled()) {
    return {
      enabled: false,
      accounts: 0,
      created: 0,
      file: null,
      registry: null,
      intake: 'skipped',
      intakeHint: null,
    }
  }
  registerAllObjectTypes()
  const sync = await MailPublic.sync()
  const registry = await MailPublic.registry()
  const report: MailSyncReport = {
    enabled: true,
    ...sync,
    registry: registry.address,
    intake: 'skipped',
    intakeHint: null,
  }
  const host = config().MAIL_IMAP_HOST.trim()
  if (!host) {
    report.intakeHint = 'MAIL_IMAP_HOST не задан — приём из ящика канцелярии не настроен'
    return report
  }
  if (await Integrations.byKey(INTAKE_KEY)) {
    report.intake = 'exists'
    return report
  }
  const registrar = await firstWithRole('registrar')
  const admin = await firstWithRole('system_admin')
  const ctx = admin ? await buildUserCtxFor(admin) : null
  if (!registrar || !ctx) {
    report.intakeHint =
      'Нет действующего делопроизводителя или администратора — приём заведите в «Интеграциях» вручную'
    return report
  }
  const port = config().MAIL_IMAP_PORT
  await Integrations.create(ctx, {
    key: INTAKE_KEY,
    kind: 'imap',
    name: 'Ящик канцелярии',
    description: `Приём в очередь «Из почты» из ${registry.address} (ADR-0150)`,
    enabled: true,
    inboundEnabled: false,
    config: {
      host,
      port,
      // TLS с первого байта; 143 — только со STARTTLS
      secure: port !== 143,
      tlsRejectUnauthorized: config().MAIL_TLS_VERIFY,
      user: registry.address,
      folder: 'INBOX',
      pollMinutes: 5,
      batchSize: 25,
      runAsUserId: registrar,
      documentTypeKey: 'incoming_letter',
      journalId: null,
      markSeen: true,
      filters: {},
    },
    secrets: { password: registry.password },
  })
  report.intake = 'created'
  return report
}

export function formatMailSync(report: MailSyncReport): string {
  if (!report.enabled) return 'Почта установки не включена: задайте MAIL_DOMAIN (ADR-0150)\n'
  const lines = [
    `Ящиков в файле учёток: ${report.accounts} (новых: ${report.created})`,
    `Файл: ${report.file ?? 'MAIL_CONFIG_DIR не задан — файл не записан'}`,
    `Ящик канцелярии: ${report.registry}`,
    report.intake === 'created'
      ? 'Приём в очередь «Из почты»: интеграция «Ящик канцелярии» заведена'
      : report.intake === 'exists'
        ? 'Приём в очередь «Из почты»: интеграция уже есть'
        : `Приём в очередь «Из почты»: ${report.intakeHint ?? 'не настроен'}`,
    `DKIM: docker compose --profile mail exec mailserver setup config dkim keysize 2048 domain ${config().MAIL_DOMAIN}`,
  ]
  return `${lines.join('\n')}\n`
}
