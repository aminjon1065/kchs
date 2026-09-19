import { type Confidentiality, isRedacted } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { createTranslator } from '@kchs/i18n'
import { adminModeActive, effectiveConfidentiality } from '~/kernel/access/confidentiality.js'
import type { Ctx } from '~/shared/context.js'

/**
 * Водяной знак файлов с грифом от «конфиденциально» (08-documents.md §13,
 * ADR-0085): гриф, кто смотрит, когда — в поясе смотрящего. Те же строки
 * рисует просмотрщик поверх страниц и печатает движок на копии для скачивания.
 */
export function watermarkLines(ctx: Ctx, level: Confidentiality, now = new Date()): string[] {
  const t = createTranslator(ctx.locale)
  const who = ctx.kind === 'user' ? ctx.displayName : t('files.watermark.system')
  const when = formatDateTime(now, {
    locale: ctx.locale,
    ...(ctx.kind === 'user' ? { timezone: ctx.timezone } : {}),
  })
  return [t(`access.confidentiality.${level}`), who, when]
}

/**
 * Файл под водяным знаком: его действующий гриф (свой или объектов, к которым
 * он прикреплён) не ниже «конфиденциально». Возвращает гриф или null.
 */
export async function watermarkLevel(fileId: string): Promise<Confidentiality | null> {
  const level = await effectiveConfidentiality(fileId)
  return isRedacted(level) ? level : null
}

/** Исходник без знака отдаётся только в режиме администратора (с аудитом). */
export function originalAllowed(ctx: Ctx): boolean {
  return ctx.kind === 'system' || adminModeActive(ctx)
}
