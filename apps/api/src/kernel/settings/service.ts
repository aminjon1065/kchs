import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { settings } from '~/shared/db/schema/index.js'
import { publishEvent } from '../events/publisher.js'

export type SettingScope = 'system' | 'space' | 'user'

/**
 * Трёхуровневые настройки: система → пространство → пользователь
 * (02-platform-kernel.md §14). Значение пользователя перекрывает пространство,
 * пространство — систему.
 */
export const SettingsService = {
  async get<T>(
    key: string,
    scopes: Array<{ scope: SettingScope; scopeId?: string | null }>,
    fallback: T,
  ): Promise<T> {
    const rows = await db()
      .select()
      .from(settings)
      .where(
        and(
          eq(settings.key, key),
          inArray(
            settings.scope,
            scopes.map((s) => s.scope),
          ),
        ),
      )

    // Порядок приоритета — обратный порядку аргументов
    for (const scope of [...scopes].reverse()) {
      const row = rows.find(
        (r) =>
          r.scope === scope.scope &&
          (scope.scopeId ? r.scopeId === scope.scopeId : r.scopeId === null),
      )
      if (row) return row.value as T
    }
    return fallback
  },

  async set(
    tx: Executor,
    ctx: Ctx,
    scope: SettingScope,
    scopeId: string | null,
    key: string,
    value: unknown,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    const existing = await tx
      .select({ key: settings.key })
      .from(settings)
      .where(
        and(
          eq(settings.scope, scope),
          scopeId ? eq(settings.scopeId, scopeId) : isNull(settings.scopeId),
          eq(settings.key, key),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      await tx
        .update(settings)
        .set({ value, updatedBy: actorId(ctx), updatedAt: sql`now()` })
        .where(
          and(
            eq(settings.scope, scope),
            scopeId ? eq(settings.scopeId, scopeId) : isNull(settings.scopeId),
            eq(settings.key, key),
          ),
        )
    } else {
      await tx.insert(settings).values({ scope, scopeId, key, value, updatedBy: actorId(ctx) })
    }

    if (!options.silent) {
      await publishEvent(tx, ctx, {
        type: 'settings.changed',
        payload: { scope, key },
      })
    }
  },

  /** Удаление настройки: пустое значение означает «вернуться к умолчанию». */
  async remove(
    tx: Executor,
    scope: SettingScope,
    scopeId: string | null,
    key: string,
  ): Promise<void> {
    await tx
      .delete(settings)
      .where(
        and(
          eq(settings.scope, scope),
          scopeId ? eq(settings.scopeId, scopeId) : isNull(settings.scopeId),
          eq(settings.key, key),
        ),
      )
  },

  async forUser(userId: string): Promise<Record<string, unknown>> {
    const rows = await db()
      .select()
      .from(settings)
      .where(and(eq(settings.scope, 'user'), eq(settings.scopeId, userId)))
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  },

  async system(): Promise<Record<string, unknown>> {
    const rows = await db().select().from(settings).where(eq(settings.scope, 'system'))
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  },
}

/** Типизированные ключи настроек платформы. */
export const SETTING_KEYS = {
  brandName: 'brand.name',
  brandShortName: 'brand.shortName',
  brandLogo: 'brand.logo',
  brandAccent: 'brand.accent',
  brandLoginNote: 'brand.loginNote',
  securityAllowShareLinks: 'security.allowShareLinks',
  securityRequireMfaRoles: 'security.requireMfaRoles',
  securityRuleEmailDomains: 'security.ruleEmailDomains',
  securityRuleWebhookDomains: 'security.ruleWebhookDomains',
  securitySessionIdleHours: 'security.sessionIdleHours',
  uiTheme: 'ui.theme',
  uiDensity: 'ui.density',
  uiAccent: 'ui.accent',
  uiFontSize: 'ui.fontSize',
  uiStartScreen: 'ui.startScreen',
  uiTabBehavior: 'ui.tabBehavior',
  workspaceState: 'workspace.state',
  homeWidgets: 'home.widgets',
  notificationDigestHour: 'notifications.digestHour',
  notificationQuietHours: 'notifications.quietHours',
  trashRetentionDays: 'trash.retentionDays',
  /** Колоночный tier: включён и порог строк (ADR-0109). */
  columnarTier: 'data.columnarTier',
  /** Отрисовка больших слоёв карты: deck.gl и порог объектов (ADR-0110). */
  gisRender: 'gis.render',
} as const
