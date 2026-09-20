import {
  DirectorySettings,
  type DirectorySettingsInput,
  SsoSettings,
  type SsoSettingsInput,
} from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { db, type Executor } from '~/shared/db/client.js'
import { authProviders } from '~/shared/db/schema/index.js'

/**
 * Настройки поставщиков входа (ADR-0098): каталог LDAP/AD и единый вход OIDC.
 * Секрет живёт отдельной зашифрованной колонкой: он никогда не попадает ни в
 * ответ API, ни в журнал, ни в событие — наружу уходит только «секрет задан».
 *
 * Читается на каждом входе, поэтому держится в памяти процесса ненадолго:
 * изменение применяется сразу там, где его сделали, и не позже CACHE_TTL_MS
 * в остальных процессах (так же, как политика безопасности).
 */
const CACHE_TTL_MS = 10_000

export const LDAP_PROVIDER = 'ldap'
export const OIDC_PROVIDER = 'oidc'

interface ProviderRow {
  enabled: boolean
  config: Record<string, unknown>
  secret: string | null
  updatedAt: string | null
}

const cache = new Map<string, { row: ProviderRow; at: number }>()

async function load(kind: string): Promise<ProviderRow> {
  const cached = cache.get(kind)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.row
  const [row] = await db().select().from(authProviders).where(eq(authProviders.kind, kind)).limit(1)
  const value: ProviderRow = {
    enabled: row?.enabled ?? false,
    config: row?.config ?? {},
    // Испорченный секрет не должен ронять вход: поставщик просто окажется ненастроенным
    secret: row?.secretEnc ? safeDecrypt(row.secretEnc) : null,
    updatedAt: row?.updatedAt ?? null,
  }
  cache.set(kind, { row: value, at: Date.now() })
  return value
}

function safeDecrypt(payload: Buffer): string | null {
  try {
    return decryptSecret(payload)
  } catch {
    return null
  }
}

async function save(
  tx: Executor,
  ctx: Ctx,
  kind: string,
  enabled: boolean,
  config: Record<string, unknown>,
  secret: string | null | undefined,
): Promise<void> {
  const [existing] = await tx
    .select({ secretEnc: authProviders.secretEnc })
    .from(authProviders)
    .where(eq(authProviders.kind, kind))
    .limit(1)

  // undefined — секрет не меняли; '' или null — стереть; строка — заменить
  const secretEnc =
    secret === undefined ? (existing?.secretEnc ?? null) : secret ? encryptSecret(secret) : null

  if (existing) {
    await tx
      .update(authProviders)
      .set({ enabled, config, secretEnc, updatedBy: actorId(ctx), updatedAt: sql`now()` })
      .where(eq(authProviders.kind, kind))
  } else {
    await tx
      .insert(authProviders)
      .values({ kind, enabled, config, secretEnc, updatedBy: actorId(ctx) })
  }

  await audit(
    ctx,
    {
      action: AUDIT_ACTIONS.authProviderChanged,
      severity: 'warning',
      details: { kind, enabled, secretChanged: secret !== undefined },
    },
    tx,
  )
  await publishEvent(tx, ctx, {
    type: 'integration.configured',
    payload: { kind, enabled },
  })
}

export const AuthProviders = {
  /** Сброс кэша процесса: после изменения настроек и в тестах. */
  invalidate(kind?: string): void {
    if (kind) cache.delete(kind)
    else cache.clear()
  },

  async directory(): Promise<{
    enabled: boolean
    settings: DirectorySettings
    bindPassword: string | null
    updatedAt: string | null
  }> {
    const row = await load(LDAP_PROVIDER)
    const parsed = DirectorySettings.safeParse(row.config)
    return {
      enabled: row.enabled && parsed.success,
      settings: parsed.success ? parsed.data : DirectorySettings.parse({}),
      bindPassword: row.secret,
      updatedAt: row.updatedAt,
    }
  },

  async saveDirectory(tx: Executor, ctx: Ctx, input: DirectorySettingsInput): Promise<void> {
    const { bindPassword, ...settings } = input
    await save(tx, ctx, LDAP_PROVIDER, settings.enabled, settings, bindPassword)
  },

  async sso(): Promise<{
    enabled: boolean
    settings: SsoSettings
    clientSecret: string | null
    updatedAt: string | null
  }> {
    const row = await load(OIDC_PROVIDER)
    const parsed = SsoSettings.safeParse(row.config)
    return {
      enabled: row.enabled && parsed.success,
      settings: parsed.success ? parsed.data : SsoSettings.parse({}),
      clientSecret: row.secret,
      updatedAt: row.updatedAt,
    }
  },

  async saveSso(tx: Executor, ctx: Ctx, input: SsoSettingsInput): Promise<void> {
    const { clientSecret, ...settings } = input
    await save(tx, ctx, OIDC_PROVIDER, settings.enabled, settings, clientSecret)
  },
}
