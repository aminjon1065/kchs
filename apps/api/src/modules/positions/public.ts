/**
 * Публичный API модуля «Местоположение» (ADR-0203) для других модулей и установки
 * предметного пакета (01-overview.md §Как модули взаимодействуют).
 */
import type { Ctx } from '~/shared/context.js'
import type { Tx } from '~/shared/db/client.js'
import { PositionsSettingsService } from './domain/settings.js'

export const PositionsSetup = {
  /**
   * Датасет проекции последних позиций — если он ещё не задан: пакет ЧС ставит
   * свой слой «Техника и группы», но выбор администратора не перезаписывает.
   */
  async ensureProjection(tx: Tx, ctx: Ctx, datasetId: string): Promise<boolean> {
    const current = await PositionsSettingsService.current()
    if (current.projectionDatasetId) return false
    await PositionsSettingsService.update(tx, ctx, { ...current, projectionDatasetId: datasetId })
    return true
  },
}
