import { Branding, type BrandingPatch } from '@kchs/contracts'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { SETTING_KEYS, SettingsService } from './service.js'

type Field = keyof Branding

const KEYS: Record<Field, string> = {
  name: SETTING_KEYS.brandName,
  shortName: SETTING_KEYS.brandShortName,
  logo: SETTING_KEYS.brandLogo,
  accent: SETTING_KEYS.brandAccent,
  loginNote: SETTING_KEYS.brandLoginNote,
}

/**
 * Брендирование читают экран входа и оболочка при каждом старте, поэтому
 * процесс держит его в памяти недолго — как политику безопасности: в своём
 * процессе изменение видно сразу, в остальных не позже CACHE_TTL_MS.
 */
const CACHE_TTL_MS = 10_000
let cached: { branding: Branding; at: number } | null = null

/** Испорченное значение заменяется умолчанием: сбой настройки не должен ломать вход. */
function fromSettings(system: Record<string, unknown>): Branding {
  const branding = Branding.parse({})
  for (const field of Object.keys(KEYS) as Field[]) {
    const raw = system[KEYS[field]]
    if (raw === undefined) continue
    const parsed = Branding.shape[field].safeParse(raw)
    if (parsed.success) Object.assign(branding, { [field]: parsed.data })
  }
  return branding
}

export const BrandingService = {
  async current(): Promise<Branding> {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.branding
    const branding = fromSettings(await SettingsService.system())
    cached = { branding, at: Date.now() }
    return branding
  },

  /** Изменение — в аудит с состоянием до и после; логотип там только по размеру. */
  async update(tx: Executor, ctx: Ctx, patch: BrandingPatch): Promise<Branding> {
    const before = fromSettings(await SettingsService.system())
    const after: Branding = { ...before }
    for (const field of Object.keys(KEYS) as Field[]) {
      const value = patch[field]
      if (value === undefined) continue
      Object.assign(after, { [field]: value })
      if (value === null || value === '') {
        await SettingsService.remove(tx, 'system', null, KEYS[field])
      } else {
        await SettingsService.set(tx, ctx, 'system', null, KEYS[field], value)
      }
    }
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.brandingChanged,
        severity: 'notice',
        details: { before: short(before), after: short(after) },
      },
      tx,
    )
    return after
  },

  /** Сброс кэша процесса: после изменения и в тестах. */
  invalidate(): void {
    cached = null
  },
}

/** В аудит идёт не сам логотип, а его размер: картинка в журнале ни к чему. */
function short(branding: Branding): Record<string, unknown> {
  const { logo, ...rest } = branding
  return { ...rest, logoBytes: logo ? logo.length : 0 }
}
