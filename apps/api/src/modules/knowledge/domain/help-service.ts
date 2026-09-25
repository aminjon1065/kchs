import {
  type HelpLink,
  HelpPages,
  type HelpPagesPatch,
  LOCALES,
  type Locale,
} from '@kchs/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { SETTING_KEYS, SettingsService } from '~/kernel/settings/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

const EMPTY: HelpPages = { ru: null, tg: null, en: null }

/** Испорченная настройка — как пустая: справка не должна ломать оболочку. */
function parse(raw: unknown): HelpPages {
  const parsed = HelpPages.partial().safeParse(raw ?? {})
  return parsed.success ? { ...EMPTY, ...parsed.data } : { ...EMPTY }
}

async function stored(): Promise<HelpPages> {
  return parse((await SettingsService.system())[SETTING_KEYS.helpPages])
}

/** Живые страницы базы знаний среди идентификаторов: id → название. */
async function livePages(ids: string[], database: Executor = db()): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await database
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .where(and(inArray(objects.id, ids), eq(objects.type, 'page'), isNull(objects.deletedAt)))
  return new Map(rows.map((row) => [row.id, row.title]))
}

/**
 * Справка (вопрос N88): пункт «Справка» открывает страницу базы знаний на языке
 * сотрудника, без неё — русскую. Страницы выбирает администратор, сид предлагает
 * корни краткого руководства и не трогает уже сделанный выбор.
 */
export const HelpService = {
  pages: stored,

  /** Что открывает «Справка» у сотрудника: видимая ему живая страница или ничего. */
  async forUser(ctx: UserCtx): Promise<HelpLink['page']> {
    const pages = await stored()
    const candidates = [...new Set([pages[ctx.locale], pages.ru].filter(Boolean))] as string[]
    const live = await livePages(candidates)
    for (const id of candidates) {
      const title = live.get(id)
      if (title === undefined) continue
      if ((await authorize(ctx, 'view', id, { soft: true })).allowed) return { id, title }
    }
    return null
  },

  /** Выбор администратора; `null` снимает страницу языка. В аудит — было и стало. */
  async update(tx: Executor, ctx: Ctx, patch: HelpPagesPatch): Promise<HelpPages> {
    const before = await stored()
    const after: HelpPages = { ...before, ...patch }
    const chosen = LOCALES.map((locale) => after[locale]).filter(Boolean) as string[]
    const live = await livePages(chosen, tx)
    const missing = LOCALES.filter((locale) => after[locale] && !live.has(after[locale] as string))
    if (missing.length > 0) {
      throw errors.validation(
        'Справкой выбирают страницу базы знаний',
        missing.map((locale) => ({ path: locale, message: 'not_a_page', code: 'not_a_page' })),
      )
    }
    await SettingsService.set(tx, ctx, 'system', null, SETTING_KEYS.helpPages, after)
    await audit(ctx, { action: AUDIT_ACTIONS.helpPagesChanged, details: { before, after } }, tx)
    return after
  },

  /** Сид: корни краткого руководства — языкам, для которых администратор ещё не выбрал. */
  async ensureDefaults(
    tx: Executor,
    ctx: Ctx,
    roots: Partial<Record<Locale, string>>,
  ): Promise<number> {
    const current = await stored()
    const patch: HelpPagesPatch = {}
    for (const locale of LOCALES) {
      const root = roots[locale]
      if (root && !current[locale]) patch[locale] = root
    }
    if (Object.keys(patch).length === 0) return 0
    await HelpService.update(tx, ctx, patch)
    return Object.keys(patch).length
  },
}
