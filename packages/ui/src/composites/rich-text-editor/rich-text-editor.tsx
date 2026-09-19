import { useEffect, useState } from 'react'
import { Skeleton } from '../../components/feedback.js'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import type { RichTextEditorProps } from './types.js'

type Runtime = typeof import('./rich-text-editor-runtime.js')

let loading: Promise<Runtime> | null = null
let loaded: Runtime | null = null

/**
 * Редактор богатого текста (ADR-0018, ADR-0070): Tiptap, тело — Tiptap JSON.
 * Совместный режим — текст во фрагменте документа Yjs: правки соавторов
 * сливаются посимвольно, их курсоры и выделения видны с подписью и цветом
 * (`personTone`), отмена — только своих правок. Панель форматирования —
 * всегда, при фокусе или без неё; горячие клавиши Tiptap работают всегда.
 * Tiptap грузится отдельным чанком при первом показе.
 */
export function RichTextEditor(props: RichTextEditorProps) {
  const t = useUiT()
  const [runtime, setRuntime] = useState<Runtime | null>(loaded)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (runtime) return
    let alive = true
    loading ??= import('./rich-text-editor-runtime.js')
    loading
      .then((module) => {
        loaded = module
        if (alive) setRuntime(module)
      })
      .catch(() => {
        // Чанк не загрузился (сеть, новая версия) — следующая попытка загрузит заново
        loading = null
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [runtime])

  if (failed) {
    return (
      <p role="alert" className={cn('text-xs text-danger', props.className)}>
        {t('ui.richText.loadFailed')}
      </p>
    )
  }
  if (!runtime) {
    return (
      <div
        className={cn('flex flex-col gap-1.5', props.className)}
        data-rich-text-state="loading"
        role="status"
        aria-label={t('ui.richText.loading')}
      >
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    )
  }
  const Editor = runtime.default
  return <Editor {...props} />
}
