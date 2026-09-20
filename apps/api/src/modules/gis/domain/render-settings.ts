import { GisRenderSettings, type GisRenderSettingsPatch } from '@kchs/contracts'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { SETTING_KEYS, SettingsService } from '~/kernel/settings/service.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'

/**
 * Отрисовка больших слоёв (07-gis-engine.md §15, ADR-0110): порог, с которого
 * карта-студия отдаёт слой deck.gl. Настройка установки — её ведёт
 * администратор, читает её каждый, кто открывает карту.
 */
export const GisRenderSettingsService = {
  async current(): Promise<GisRenderSettings> {
    const raw = await SettingsService.get<unknown>(
      SETTING_KEYS.gisRender,
      [{ scope: 'system' }],
      {},
    )
    const parsed = GisRenderSettings.safeParse(raw ?? {})
    return parsed.success ? parsed.data : GisRenderSettings.parse({})
  },

  async update(ctx: UserCtx, patch: GisRenderSettingsPatch): Promise<GisRenderSettings> {
    const before = await GisRenderSettingsService.current()
    const after = GisRenderSettings.parse({ ...before, ...patch })
    await db().transaction(async (tx) => {
      await SettingsService.set(tx, ctx, 'system', null, SETTING_KEYS.gisRender, after)
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.settingsChanged,
          severity: 'notice',
          details: { setting: SETTING_KEYS.gisRender, before, after },
        },
        tx,
      )
    })
    return after
  },
}
