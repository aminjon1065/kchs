import { type TranslateInput, TranslateLanguage, type TranslateResult } from '@kchs/contracts'
import { z } from 'zod'
import type { UserCtx } from '~/shared/context.js'
import { AiService } from './service.js'

/**
 * Перевод текста между языками платформы (13-search-knowledge-ai.md §4):
 * сообщения, реквизиты документов и куски страниц. Модель возвращает только
 * перевод и язык оригинала — ничего не делает с объектами.
 */

const NAMES: Record<string, string> = {
  ru: 'русский',
  tg: 'таджикский',
  en: 'английский',
}

const Answer = z.object({
  text: z.string().max(12_000),
  from: TranslateLanguage.or(z.string().max(20)),
})

export const Translate = {
  async run(ctx: UserCtx, input: TranslateInput): Promise<TranslateResult> {
    return AiService.complete(
      ctx,
      {
        feature: 'translate',
        system: [
          'Ты переводчик делового текста государственной организации.',
          'Переводи точно, сохраняя смысл, числа, имена собственные и переносы строк.',
          'Ничего не добавляй от себя и не комментируй перевод.',
        ].join(' '),
        prompt: [
          `Переведи на язык: ${NAMES[input.to] ?? input.to}.`,
          'Верни перевод и язык оригинала.',
          '---',
          input.text,
        ].join('\n'),
        schema: Answer,
        schemaName: 'translate',
        maxTokens: 3000,
        details: { to: input.to, chars: input.text.length },
        // В аудит — объём, а не текст: переводить могут переписку и документы
        auditAnswer: false,
      },
      async (answer) => ({ text: answer.text, from: answer.from }),
    )
  },
}
