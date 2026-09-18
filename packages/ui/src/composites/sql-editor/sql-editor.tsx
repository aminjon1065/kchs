import { AlertCircle } from 'lucide-react'
import {
  type CSSProperties,
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { formatShortcut } from '../../hooks/use-hotkeys.js'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import { cspNonce } from '../../lib/csp-nonce.js'
import { Button } from '../../primitives/button.js'
import { SQL_EDITOR_FUNCTIONS } from './functions.js'
import type { SqlCompletionData } from './sql-completion.js'
import type { SqlEditorController, SqlEditorViewConfig } from './sql-editor-runtime.js'
import type {
  SqlEditorDiagnostic,
  SqlEditorHandle,
  SqlEditorParam,
  SqlEditorProps,
  SqlEditorTable,
} from './types.js'

/** Фразы CodeMirror (поиск, список ошибок, подсказки) → ключи `ui.sqlEditor.phrases.*`. */
const PHRASES: Record<string, string> = {
  Completions: 'completions',
  Diagnostics: 'diagnostics',
  'No diagnostics': 'noDiagnostics',
  close: 'close',
  Find: 'find',
  Replace: 'replace',
  next: 'next',
  previous: 'previous',
  all: 'all',
  'match case': 'matchCase',
  regexp: 'regexp',
  'by word': 'byWord',
  replace: 'replaceOne',
  'replace all': 'replaceAll',
  'current match': 'currentMatch',
  'on line': 'onLine',
  'replaced $ matches': 'replacedMatches',
  'replaced match on line $': 'replacedMatchOnLine',
  'Go to line': 'goToLine',
  go: 'go',
  'Selection deleted': 'selectionDeleted',
  'Control character': 'controlCharacter',
}

const NO_TABLES: readonly SqlEditorTable[] = []
const NO_PARAMS: readonly SqlEditorParam[] = []
const NO_DIAGNOSTICS: readonly SqlEditorDiagnostic[] = []

/** Строка и столбец (с 1) смещения — для озвучивания ошибок. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  return {
    line: before.split('\n').length,
    column: before.length - before.lastIndexOf('\n'),
  }
}

type Status = 'loading' | 'ready' | 'error'

/**
 * Редактор SQL-лаборатории (P1-E05 S02, 06-analytics-engine.md §6): CodeMirror 6
 * с диалектом PostgreSQL, лениво отдельным чанком. Автодополнение по
 * «человеческим» именам и ключам таблиц и полей (`Происшествия.Дата`), параметры
 * `{{name}}` с подсветкой и подсказками, функции и ключевые слова; ошибки с
 * позицией — подчёркивание и подсказка (у курсора — и без мыши), озвучиваются
 * через aria-describedby. ⌘/Ctrl+Enter — выполнить; Tab — отступ, Escape и Tab —
 * выход из редактора. Строгий CSP: стили CodeMirror — в <style> с nonce страницы.
 */
export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  {
    value,
    onChange,
    onRun,
    schema,
    params,
    functions,
    diagnostics,
    readOnly = false,
    placeholder,
    'aria-label': ariaLabel,
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
    height = 'auto',
    minHeight = 120,
    maxHeight = 480,
    lineNumbers = true,
    autoFocus = false,
    className,
  },
  ref,
) {
  const t = useUiT()
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [attempt, setAttempt] = useState(0)
  const controller = useRef<SqlEditorController | null>(null)
  // Вызовы через ref до загрузки редактора выполняются после неё
  const pending = useRef<Array<(editor: SqlEditorController) => void>>([])
  const hintId = useId()
  const diagnosticsId = useId()
  const run = formatShortcut('mod+enter')
  const list = diagnostics ?? NO_DIAGNOSTICS
  const placeholderText = placeholder ?? t('ui.sqlEditor.placeholder', { run })

  const config = useMemo<SqlEditorViewConfig>(
    () => ({
      readOnly,
      placeholder: placeholderText,
      lineNumbers,
      label: ariaLabel ?? t('ui.sqlEditor.label'),
      labelledBy,
      describedBy: [hintId, list.length > 0 ? diagnosticsId : null, describedBy]
        .filter(Boolean)
        .join(' '),
      invalid: list.some((item) => (item.severity ?? 'error') === 'error'),
      phrases: Object.fromEntries(
        Object.entries(PHRASES).map(([phrase, key]) => [phrase, t(`ui.sqlEditor.phrases.${key}`)]),
      ),
    }),
    [
      readOnly,
      placeholderText,
      lineNumbers,
      ariaLabel,
      labelledBy,
      describedBy,
      hintId,
      diagnosticsId,
      list,
      t,
    ],
  )

  const completion = useMemo<SqlCompletionData>(
    () => ({
      schema: schema ?? NO_TABLES,
      params: params ?? NO_PARAMS,
      functions: functions ?? SQL_EDITOR_FUNCTIONS,
      texts: { table: t('ui.sqlEditor.kind.table'), param: t('ui.sqlEditor.kind.param') },
    }),
    [schema, params, functions, t],
  )

  // Колбэки редактора читают актуальные пропсы; редактор создаётся с последними значениями
  const latest = useRef({ value, onChange, onRun, config, completion, list, autoFocus })
  latest.current = { value, onChange, onRun, config, completion, list, autoFocus }
  /**
   * Последний текст, отданный через onChange. Проп `value`, равный ему, — эхо
   * правки пользователя: в документ он не возвращается. Иначе отстающее эхо
   * при быстром наборе откатывало бы свежий ввод, а откат снова вызывал бы
   * onChange внутри отрисовки — бесконечный цикл обновлений.
   */
  const emitted = useRef<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt — повтор загрузки после ошибки
  useEffect(() => {
    if (!host) return
    let disposed = false
    let created: SqlEditorController | null = null
    setStatus('loading')
    const start = async () => {
      // CodeMirror — отдельный чанк: грузится, когда на экране появился редактор, и один раз
      const createSqlEditor = await import('./sql-editor-runtime.js').then(
        (runtime) => runtime.createSqlEditor,
        () => null,
      )
      if (disposed) return
      // Чанк не загрузился (сеть, новая сборка на сервере) — ошибка с повтором
      if (!createSqlEditor) {
        setStatus('error')
        return
      }
      const current = latest.current
      const editor = createSqlEditor({
        parent: host,
        value: current.value,
        config: current.config,
        completion: current.completion,
        diagnostics: current.list,
        nonce: cspNonce(),
        onChange: (next) => {
          emitted.current = next
          latest.current.onChange?.(next)
        },
        onRun: (text, selection) => {
          const handler = latest.current.onRun
          if (!handler) return false
          handler(text, selection)
          return true
        },
      })
      created = editor
      controller.current = editor
      for (const action of pending.current.splice(0)) action(editor)
      if (current.autoFocus) editor.focus()
      setStatus('ready')
    }
    void start()
    return () => {
      disposed = true
      created?.destroy()
      controller.current = null
    }
  }, [host, attempt])

  // Пропсы → редактор без пересоздания (до загрузки их читает создание редактора)
  useEffect(() => {
    if (value === emitted.current) return
    controller.current?.setValue(value)
  }, [value])
  useEffect(() => controller.current?.setConfig(config), [config])
  useEffect(() => controller.current?.setCompletion(completion), [completion])
  useEffect(() => controller.current?.setDiagnostics(list), [list])

  useImperativeHandle(ref, () => {
    const call = (action: (editor: SqlEditorController) => void) => {
      if (controller.current) action(controller.current)
      else pending.current.push(action)
    }
    return {
      focus: () => call((editor) => editor.focus()),
      insert: (text) => call((editor) => editor.insert(text)),
      select: (from, to) => call((editor) => editor.select(from, to)),
    }
  }, [])

  const fixed = height !== 'auto'
  // Высота — переменными: их читает тема CodeMirror (sql-editor-theme.ts)
  const sizing: Record<string, string | number | undefined> = fixed
    ? {
        height: typeof height === 'number' ? height : undefined,
        '--sql-editor-height': '100%',
        '--sql-editor-min-height': '100%',
      }
    : {
        '--sql-editor-min-height': `${minHeight}px`,
        '--sql-editor-max-height': `${maxHeight}px`,
      }
  // Фон номеров строк — как у поля: прокрученный вбок текст уходит под них
  sizing['--sql-editor-bg'] = readOnly ? 'var(--bg-surface-2)' : 'var(--bg-surface)'
  const style = sizing as CSSProperties

  return (
    <div
      data-field
      data-sql-editor-state={status}
      aria-busy={status === 'loading' || undefined}
      style={style}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-sm border border-line-strong bg-surface',
        'font-mono text-sm text-fg transition-colors duration-[var(--duration-fast)]',
        'focus-within:border-accent',
        readOnly && 'bg-surface-2',
        height === 'fill' && 'h-full',
        className,
      )}
    >
      {status === 'error' ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-line bg-danger-subtle px-3 py-2 font-sans text-sm"
        >
          <AlertCircle aria-hidden className="size-4 shrink-0 text-danger" />
          <span className="min-w-0 flex-1">{t('ui.sqlEditor.loadFailed')}</span>
          <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            {t('ui.actions.retry')}
          </Button>
        </div>
      ) : null}
      {/* CodeMirror монтируется сюда; до загрузки — текст запроса как есть */}
      <div
        ref={setHost}
        className={cn('flex min-h-0 flex-col', status === 'ready' && fixed && 'flex-1')}
      />
      {status === 'ready' ? null : (
        <pre
          aria-hidden
          className={cn(
            'm-0 min-h-[var(--sql-editor-min-height)] max-h-[var(--sql-editor-max-height,none)] flex-1 overflow-hidden whitespace-pre px-2 py-2 font-mono',
            !value && 'text-fg-muted',
          )}
        >
          {value || placeholderText}
        </pre>
      )}
      <p id={hintId} className="sr-only">
        {t('ui.sqlEditor.hint')}
      </p>
      {list.length > 0 ? (
        <ul id={diagnosticsId} className="sr-only">
          {list.map((item, index) => {
            const { line, column } = lineColumn(value, item.from)
            return (
              <li key={index}>
                {t('ui.sqlEditor.diagnostic', {
                  severity: t(`ui.sqlEditor.severity.${item.severity ?? 'error'}`),
                  line,
                  column,
                  message: item.message,
                })}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
})
