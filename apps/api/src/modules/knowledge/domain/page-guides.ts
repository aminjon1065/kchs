import type { Locale } from '@kchs/contracts'
import { GUIDE_PAGES, GUIDE_ROOT } from './page-guide.js'
import type { GuidePage } from './page-guide-kit.js'

/**
 * Краткое руководство на языках интерфейса (вопрос N88: руководства переводятся
 * вместе с интерфейсом). У каждого языка своё дерево страниц в разделе «Обучение»;
 * пункт «Справка» открывает корень дерева на языке сотрудника, без перевода —
 * русский.
 */
export interface Guide {
  locale: Locale
  root: GuidePage
  pages: readonly GuidePage[]
}

export const GUIDES: readonly Guide[] = [{ locale: 'ru', root: GUIDE_ROOT, pages: GUIDE_PAGES }]
