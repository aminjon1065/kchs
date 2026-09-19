import type { RichBody } from '@kchs/contracts'
import type { XmlFragment } from 'yjs'
import type { PersonTone } from '../../lib/person-tone.js'

/** Соавтор в совместном документе: подпись курсора и его цвет (как у аватара — `personTone`). */
export interface Collaborator {
  name: string
  tone: PersonTone
}

/**
 * Присутствие соавторов — awareness провайдера Yjs (y-protocols). Описано по
 * форме, чтобы дизайн-система не зависела от провайдера.
 */
export interface CollabAwareness {
  clientID: number
  getLocalState(): Record<string, unknown> | null
  setLocalStateField(field: string, value: unknown): void
  getStates(): Map<number, Record<string, unknown>>
  on(event: 'change' | 'update', handler: (...args: unknown[]) => void): void
  off(event: 'change' | 'update', handler: (...args: unknown[]) => void): void
}

export interface RichTextCollaboration {
  /** Текст в документе Yjs (раскладка y-prosemirror). */
  fragment: XmlFragment
  /** Присутствие: курсоры и выделения соавторов; без него — правка без курсоров. */
  awareness?: CollabAwareness | null
  /** Кто пишет — так его курсор видят остальные. */
  user?: Collaborator
}

export interface RichTextEditorProps {
  /** Несовместный режим: документ Tiptap JSON… */
  value?: RichBody
  /** …и его изменения. */
  onChange?: (value: RichBody) => void
  /** Совместный режим: текст — фрагмент документа Yjs, история правок — своя у каждого автора. */
  collaboration?: RichTextCollaboration
  /** false — только чтение: панели форматирования нет, текст выделяется и копируется. */
  editable?: boolean
  placeholder?: string
  /**
   * Панель форматирования: `always` — всегда, `focus` — пока фокус в редакторе
   * (ячейки тетради), `none` — без панели (горячие клавиши работают).
   */
  toolbar?: 'always' | 'focus' | 'none'
  'aria-label': string
  /** Описание для скринридера: подсказка, ошибка. */
  'aria-describedby'?: string
  autoFocus?: boolean
  className?: string
  onFocus?: () => void
  onBlur?: () => void
}
