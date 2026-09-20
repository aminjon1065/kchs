import type { PageBlock, PageTemplate } from '@kchs/contracts'
import { createTranslator, type Locale } from '@kchs/i18n'

/**
 * Шаблоны страниц (13-search-knowledge-ai.md §2, ADR-0095): инструкция,
 * регламент, справочник, FAQ. Шаблон — заготовка блоков на языке автора;
 * дальше страница правится как обычная, связи с шаблоном не остаётся.
 */

/** Разделы шаблона: ключ словаря подписи и ключ подсказки-абзаца. */
const SECTIONS: Record<Exclude<PageTemplate, 'blank'>, readonly string[]> = {
  instruction: ['purpose', 'scope', 'steps', 'exceptions', 'contacts'],
  regulation: ['purpose', 'terms', 'roles', 'order', 'deadlines', 'control'],
  reference: ['purpose', 'table', 'sources'],
  faq: ['purpose', 'questions'],
}

/** Абзац-подсказка раздела: его правят или стирают. */
function paragraph(text: string): PageBlock {
  return {
    id: '',
    kind: 'text',
    title: null,
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  }
}

/** Пустая таблица справочника: два столбца, одна строка для заполнения. */
function table(columns: string[]): PageBlock {
  return { id: '', kind: 'table', title: null, columns, rows: [columns.map(() => '')] }
}

/**
 * Блоки шаблона с идентификаторами `tpl-1`, `tpl-2`… — идентификаторы в
 * документе Yjs уникальны, и одинаковый вход даёт одинаковый документ.
 */
export function templateBlocks(template: PageTemplate, locale: Locale): PageBlock[] {
  if (template === 'blank') return []
  const t = createTranslator(locale)
  const blocks: PageBlock[] = []
  for (const section of SECTIONS[template]) {
    const title = t(`knowledge.templates.${template}.${section}.title`)
    const hint = t(`knowledge.templates.${template}.${section}.hint`)
    if (template === 'reference' && section === 'table') {
      blocks.push({
        ...table([
          t('knowledge.templates.reference.table.term'),
          t('knowledge.templates.reference.table.meaning'),
        ]),
        title,
      })
      continue
    }
    blocks.push({ ...paragraph(hint), title })
  }
  return blocks.map((block, index) => ({ ...block, id: `tpl-${index + 1}` }))
}
