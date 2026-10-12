import { POSITIONS_DEFAULT_SETTINGS, PositionsSettings } from '@kchs/contracts'
import { authorize } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { SettingsService } from '~/kernel/settings/service.js'
import { datasetRecord } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import type { Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'

/** Ключ системной настройки модуля (ADR-0203). */
const SETTINGS_KEY = 'positions.settings'

/**
 * Настройки местоположения установки: срок хранения точек, датасет проекции
 * последних позиций (слой карты обстановки), порог «нет связи». Испорченное
 * значение заменяется умолчанием; правка — в аудит.
 */
export const PositionsSettingsService = {
  async current(): Promise<PositionsSettings> {
    const raw = await SettingsService.get<unknown>(
      SETTINGS_KEY,
      [{ scope: 'system' }],
      POSITIONS_DEFAULT_SETTINGS,
    )
    const parsed = PositionsSettings.safeParse({
      ...POSITIONS_DEFAULT_SETTINGS,
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
    })
    return parsed.success ? parsed.data : POSITIONS_DEFAULT_SETTINGS
  },

  async update(tx: Tx, ctx: Ctx, next: PositionsSettings): Promise<PositionsSettings> {
    if (next.projectionDatasetId) {
      // Проекция пишет строки датасета: он должен существовать и быть виден настраивающему
      await authorize(ctx, 'view', next.projectionDatasetId)
      const dataset = await datasetRecord(next.projectionDatasetId).catch(() => null)
      if (!dataset) throw errors.validation('Датасет проекции не найден')
    }
    const before = await PositionsSettingsService.current()
    await SettingsService.set(tx, ctx, 'system', null, SETTINGS_KEY, next)
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.settingsChanged,
        details: { key: SETTINGS_KEY, before, after: next },
        severity: 'notice',
      },
      tx,
    )
    return next
  },
}
