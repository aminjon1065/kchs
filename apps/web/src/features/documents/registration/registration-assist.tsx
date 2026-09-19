import type { ReactNode } from 'react'
import type { CardValue } from '../card/requisites-form.js'

/**
 * Слот помощника регистрации (08-documents.md §5; вторая волна P3-E02 S02):
 * OCR скана → автозаполнение полей ИИ с подсветкой уверенности (подтверждение
 * человеком обязательно), клик по полю — подсветка зоны на скане. Экран
 * регистрации передаёт сюда черновик, скан, значения карточки и поле в фокусе;
 * вторая волна пишет только этот файл.
 */
export interface RegistrationAssistProps {
  /** Черновик создаётся с первым сканом или сохранением. */
  documentId: string | null
  /** Основной файл текущей версии (скан). */
  scanFileId: string | null
  value: CardValue
  onChange: (value: CardValue) => void
  /** Ключ реквизита или поля карточки в фокусе (`subject`, `fields.pages`). */
  activeField: string | null
}

/** Панель над карточкой: «Заполнить по скану», предложения ИИ. Сейчас — пусто. */
export function RegistrationAssist(_props: RegistrationAssistProps): ReactNode {
  return null
}

/** Зона активного поля поверх страницы скана. Сейчас подсветки нет. */
export function assistOverlay(_props: RegistrationAssistProps, _page: number): ReactNode {
  return null
}
