import { z } from 'zod'

/**
 * Отрисовка больших слоёв в карте-студии (07-gis-engine.md §15, ADR-0110):
 * с какого числа объектов слой рисует deck.gl вместо MapLibre.
 */
export const GisRenderSettings = z.object({
  /** deck.gl включён: иначе всё рисует MapLibre, как прежде. */
  deckEnabled: z.boolean().default(true),
  /** Порог числа объектов слоя, с которого включается deck.gl. */
  deckThreshold: z.number().int().min(1000).max(100_000_000).default(50_000),
})
export type GisRenderSettings = z.infer<typeof GisRenderSettings>

export const GisRenderSettingsPatch = z.object({
  deckEnabled: z.boolean().optional(),
  deckThreshold: z.number().int().min(1000).max(100_000_000).optional(),
})
export type GisRenderSettingsPatch = z.infer<typeof GisRenderSettingsPatch>
