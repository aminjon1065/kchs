import { z } from 'zod'

/**
 * Флаги функций установки (15-admin-operations.md §1): возможность, без которой
 * организация обходится, выключается целиком — экраны исчезают из оболочки, а
 * её маршруты отвечают «не найдено». Значения — системные настройки
 * `features.<ключ>`; меняет администратор системы, изменение идёт в аудит.
 */
export const FeatureFlag = z.object({
  key: z.string().min(1).max(64),
  /** Ключ словаря с названием возможности — не сам текст. */
  titleKey: z.string().min(1).max(120),
  /** Ключ словаря с пояснением: что перестанет работать. */
  hintKey: z.string().min(1).max(120),
  enabled: z.boolean(),
  /** Значение установки по умолчанию. */
  fallback: z.boolean(),
  /** Экраны оболочки, которые прячутся вместе с возможностью. */
  screens: z.array(z.string().min(1).max(40)).default([]),
  /** Сколько объектов уже заведено: выключать возможность с данными — решение осознанное. */
  objects: z.number().int().min(0).default(0),
})
export type FeatureFlag = z.infer<typeof FeatureFlag>

export const FeatureFlagList = z.object({ items: z.array(FeatureFlag) })
export type FeatureFlagList = z.infer<typeof FeatureFlagList>

export const FeatureFlagPatch = z.object({ enabled: z.boolean() })
export type FeatureFlagPatch = z.infer<typeof FeatureFlagPatch>
