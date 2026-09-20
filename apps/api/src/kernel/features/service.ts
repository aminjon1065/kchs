import type { FeatureFlag } from '@kchs/contracts'
import { inArray, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { SettingsService } from '../settings/service.js'
import { type FeatureDefinition, getFeature, listFeatures } from './registry.js'

/** Ключ системной настройки возможности. */
export function featureKey(key: string): string {
  return `features.${key}`
}

/**
 * Значения читаются на каждом запросе, поэтому процесс держит их в памяти
 * недолго — как политика безопасности: в своём процессе изменение видно сразу,
 * в остальных (api и worker — разные процессы) не позже чем через CACHE_TTL_MS.
 */
const CACHE_TTL_MS = 10_000
let cached: { values: Map<string, boolean>; at: number } | null = null

function fromSettings(system: Record<string, unknown>): Map<string, boolean> {
  const values = new Map<string, boolean>()
  for (const feature of listFeatures()) {
    const raw = system[featureKey(feature.key)]
    values.set(feature.key, typeof raw === 'boolean' ? raw : (feature.fallback ?? true))
  }
  return values
}

/** Сколько объектов возможности заведено: администратор видит цену выключения. */
async function countObjects(definitions: FeatureDefinition[]): Promise<Map<string, number>> {
  const types = [...new Set(definitions.flatMap((item) => item.objectTypes ?? []))]
  const counts = new Map<string, number>()
  if (types.length === 0) return counts
  const rows = await db()
    .select({ type: objects.type, count: sql<number>`count(*)::int` })
    .from(objects)
    .where(inArray(objects.type, types))
    .groupBy(objects.type)
  const byType = new Map(rows.map((row) => [row.type, row.count]))
  for (const definition of definitions) {
    const total = (definition.objectTypes ?? []).reduce(
      (sum, type) => sum + (byType.get(type) ?? 0),
      0,
    )
    counts.set(definition.key, total)
  }
  return counts
}

export const FeatureService = {
  /** Значения всех возможностей; неизвестные ключи считаются включёнными. */
  async values(): Promise<Map<string, boolean>> {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values
    const values = fromSettings(await SettingsService.system())
    cached = { values, at: Date.now() }
    return values
  },

  async enabled(key: string): Promise<boolean> {
    const values = await this.values()
    return values.get(key) ?? true
  },

  /** Ключи включённых возможностей — оболочке в `/me`. */
  async enabledKeys(): Promise<string[]> {
    const values = await this.values()
    return [...values.entries()].filter(([, enabled]) => enabled).map(([key]) => key)
  },

  /** Экраны выключенных возможностей — оболочке в `/me`. */
  async hiddenScreens(): Promise<string[]> {
    const values = await this.values()
    return listFeatures()
      .filter((feature) => !(values.get(feature.key) ?? true))
      .flatMap((feature) => feature.screens ?? [])
  },

  /** Список для администрирования: значение, умолчание, экраны и число объектов. */
  async list(): Promise<FeatureFlag[]> {
    const definitions = listFeatures()
    const [values, counts] = await Promise.all([this.values(), countObjects(definitions)])
    return definitions.map((definition) => ({
      key: definition.key,
      titleKey: definition.titleKey,
      hintKey: definition.hintKey,
      enabled: values.get(definition.key) ?? true,
      fallback: definition.fallback ?? true,
      screens: definition.screens ?? [],
      objects: counts.get(definition.key) ?? 0,
    }))
  },

  /**
   * Включение и выключение: значение по умолчанию удаляет настройку, чтобы
   * установка следовала умолчанию и дальше. Кэш процесса сбрасывает вызывающий
   * после коммита — см. `invalidate`.
   */
  async set(tx: Executor, ctx: Ctx, key: string, enabled: boolean): Promise<void> {
    const definition = getFeature(key)
    if (!definition) throw new Error(`Неизвестная возможность: ${key}`)
    const before = (await this.values()).get(key) ?? true
    if (enabled === (definition.fallback ?? true)) {
      await SettingsService.remove(tx, 'system', null, featureKey(key))
    } else {
      await SettingsService.set(tx, ctx, 'system', null, featureKey(key), enabled)
    }
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.featureChanged,
        severity: 'notice',
        details: { feature: key, before, after: enabled },
      },
      tx,
    )
  },

  /** Сброс кэша процесса: после изменения и в тестах. */
  invalidate(): void {
    cached = null
  },
}
