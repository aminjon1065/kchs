/**
 * Ленивая часть SqlEditor: CodeMirror 6 с диалектом PostgreSQL. Модуль грузится
 * динамическим import() из sql-editor.tsx отдельным чанком — экраны без
 * редактора его не скачивают (как ECharts у Chart).
 *
 * Строгий CSP (ADR-0043): CodeMirror вставляет правила тем через style-mod в
 * элемент <style> — он получает nonce страницы (`EditorView.cspNonce`). Атрибуты
 * `style` CodeMirror выставляет через CSSOM (`style.cssText`), это CSP разрешает.
 */
import {
  acceptCompletion,
  autocompletion,
  type Completion,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import {
  type Diagnostic,
  forEachDiagnostic,
  lintKeymap,
  setDiagnostics,
  setDiagnosticsEffect,
} from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  showTooltip,
  type Tooltip,
} from '@codemirror/view'
import { type SqlCompletionData, sqlCompletionSources } from './sql-completion.js'
import { toEditorDiagnostics } from './sql-diagnostics.js'
import { sqlEditorTheme, sqlHighlightStyle } from './sql-editor-theme.js'
import { isUnicodeWord, lexSql } from './sql-lexer.js'
import type { SqlEditorDiagnostic, SqlEditorSelection } from './types.js'

/** Настройки, которые меняются без пересоздания редактора (Compartment). */
export interface SqlEditorViewConfig {
  readOnly: boolean
  placeholder: string
  lineNumbers: boolean
  /** Доступное имя, если нет `labelledBy`. */
  label: string
  labelledBy?: string
  describedBy?: string
  invalid: boolean
  /** Переводы фраз CodeMirror (поиск, список ошибок, подсказки). */
  phrases: Readonly<Record<string, string>>
}

export interface SqlEditorRuntimeOptions {
  parent: HTMLElement
  value: string
  config: SqlEditorViewConfig
  completion: SqlCompletionData
  diagnostics: readonly SqlEditorDiagnostic[]
  /** nonce CSP для <style> тем CodeMirror. */
  nonce?: string
  onChange: (value: string) => void
  /** ⌘/Ctrl+Enter; `false` — не обработано (обычный перенос строки). */
  onRun: (value: string, selection: SqlEditorSelection | null) => boolean
}

export interface SqlEditorController {
  setValue(value: string): void
  setConfig(config: SqlEditorViewConfig): void
  setCompletion(data: SqlCompletionData): void
  setDiagnostics(list: readonly SqlEditorDiagnostic[]): void
  focus(): void
  insert(text: string): void
  select(from: number, to?: number): void
  destroy(): void
}

// ─── Оверлей подсветки: параметры и имена на любом алфавите ─────────────────

const paramMark = Decoration.mark({ class: 'cm-sqlParam' })
const nameMark = Decoration.mark({ class: 'cm-sqlName' })
/** На очень длинном тексте оверлей не строится: весь текст разбирается на каждую правку. */
const OVERLAY_LIMIT = 200_000

function overlayDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString()
  if (text.length > OVERLAY_LIMIT) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  for (const token of lexSql(text)) {
    if (token.type === 'param') builder.add(token.from, token.to, paramMark)
    // Лексер lang-sql видит в `Население_2020` ошибки и число — имя красится целиком как имя
    else if (token.type === 'word' && isUnicodeWord(text.slice(token.from, token.to))) {
      builder.add(token.from, token.to, nameMark)
    }
  }
  return builder.finish()
}

/** Метки оверлея — внутренние (наивысший приоритет): их цвет перекрывает подсветку lang-sql. */
const overlay = StateField.define<DecorationSet>({
  create: overlayDecorations,
  update: (value, tr) => (tr.docChanged ? overlayDecorations(tr.state) : value),
  provide: (field) => Prec.highest(EditorView.decorations.from(field)),
})

// ─── Ошибка под курсором: подсказка видна и без мыши ─────────────────────────

const focusEffect = StateEffect.define<boolean>()
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(focusEffect)) return effect.value
    return value
  },
})

const tooltipDiagnostics = new WeakMap<Tooltip, Diagnostic[]>()

function renderDiagnostics(list: readonly Diagnostic[]): HTMLElement {
  const dom = document.createElement('ul')
  dom.className = 'cm-tooltip-lint'
  for (const diagnostic of list) {
    const item = dom.appendChild(document.createElement('li'))
    item.className = `cm-diagnostic cm-diagnostic-${diagnostic.severity}`
    const text = item.appendChild(document.createElement('span'))
    text.className = 'cm-diagnosticText'
    text.textContent = diagnostic.message
  }
  return dom
}

function cursorTooltip(state: EditorState, previous: Tooltip | null): Tooltip | null {
  if (!state.field(focused)) return null
  const head = state.selection.main.head
  const found: Diagnostic[] = []
  let anchor = head
  forEachDiagnostic(state, (diagnostic, from, to) => {
    if (head < from || head > to) return
    found.push(diagnostic)
    anchor = Math.min(anchor, from)
  })
  if (found.length === 0) return null
  // Те же ошибки — та же подсказка: без перерисовки на каждом шаге курсора
  const shown = previous ? tooltipDiagnostics.get(previous) : undefined
  if (previous && shown?.length === found.length && shown.every((d, i) => d === found[i])) {
    return previous
  }
  const tooltip: Tooltip = {
    pos: anchor,
    above: true,
    create: () => ({ dom: renderDiagnostics(found) }),
  }
  tooltipDiagnostics.set(tooltip, found)
  return tooltip
}

const cursorDiagnostic = StateField.define<Tooltip | null>({
  create: (state) => cursorTooltip(state, null),
  update(value, tr) {
    const relevant =
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((effect) => effect.is(focusEffect) || effect.is(setDiagnosticsEffect))
    return relevant ? cursorTooltip(tr.state, value) : value
  },
  provide: (field) => showTooltip.from(field),
})

// ─── Значки подсказок: глифы Lucide (ISC), как во всём интерфейсе ─────────────

type Shape = [tag: string, attrs: Record<string, string>]

const ICONS: Record<string, Shape[]> = {
  // table-2 — глиф датасета (ObjectIcon)
  table: [
    [
      'path',
      {
        d: 'M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18',
      },
    ],
  ],
  // columns-3
  column: [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'M9 3v18' }],
    ['path', { d: 'M15 3v18' }],
  ],
  // braces
  param: [
    ['path', { d: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1' }],
    ['path', { d: 'M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1' }],
  ],
  // square-function
  function: [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }],
    ['path', { d: 'M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3' }],
    ['path', { d: 'M9 11.2h5.7' }],
  ],
  // code
  keyword: [
    ['path', { d: 'm16 18 6-6-6-6' }],
    ['path', { d: 'm8 6-6 6 6 6' }],
  ],
  // type
  type: [
    ['path', { d: 'M12 4v16' }],
    ['path', { d: 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2' }],
    ['path', { d: 'M9 20h6' }],
  ],
}

const SVG = 'http://www.w3.org/2000/svg'

function completionIcon(completion: Completion): Node | null {
  const shapes = ICONS[completion.type ?? '']
  if (!shapes) return null
  const svg = document.createElementNS(SVG, 'svg')
  const attrs: Record<string, string> = {
    class: `cm-completionIcon cm-completionIcon-${completion.type}`,
    viewBox: '0 0 24 24',
    width: '14',
    height: '14',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value)
  for (const [tag, shape] of shapes) {
    const node = svg.appendChild(document.createElementNS(SVG, tag))
    for (const [name, value] of Object.entries(shape)) node.setAttribute(name, value)
  }
  return svg
}

// ─── Редактор ───────────────────────────────────────────────────────────────

/** Правка пришла из пропа `value`, а не от пользователя: onChange её не повторяет. */
const external = Annotation.define<boolean>()

function contentAttributes(config: SqlEditorViewConfig): Record<string, string> {
  const attrs: Record<string, string> = config.labelledBy
    ? { 'aria-labelledby': config.labelledBy }
    : { 'aria-label': config.label }
  if (config.describedBy) attrs['aria-describedby'] = config.describedBy
  if (config.invalid) attrs['aria-invalid'] = 'true'
  return attrs
}

const gutter = (enabled: boolean): Extension =>
  enabled ? [lineNumbers(), highlightActiveLineGutter()] : []

/** Та же диагностика по содержанию: экран может передавать новый массив на каждой отрисовке. */
function sameDiagnostics(
  a: readonly SqlEditorDiagnostic[],
  b: readonly SqlEditorDiagnostic[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        item.from === other.from &&
        item.to === other.to &&
        item.message === other.message &&
        item.severity === other.severity
      )
    })
  )
}

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export function createSqlEditor(options: SqlEditorRuntimeOptions): SqlEditorController {
  let config = options.config
  let completion = options.completion
  let diagnostics = options.diagnostics
  const readOnly = new Compartment()
  const empty = new Compartment()
  const numbers = new Compartment()
  const attributes = new Compartment()
  const phrases = new Compartment()

  const run = (view: EditorView) => {
    const range = view.state.selection.main
    const selection = range.empty
      ? null
      : { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) }
    return options.onRun(view.state.doc.toString(), selection)
  }

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.value,
      extensions: [
        // ⌘/Ctrl+Enter раньше всего: и при открытом списке подсказок выполняет запрос
        Prec.highest(keymap.of([{ key: 'Mod-Enter', run, preventDefault: true }])),
        options.nonce ? EditorView.cspNonce.of(options.nonce) : [],
        numbers.of(gutter(config.lineNumbers)),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
        syntaxHighlighting(sqlHighlightStyle),
        bracketMatching(),
        closeBrackets(),
        autocompletion({
          override: sqlCompletionSources(() => completion),
          icons: false,
          addToOptions: [{ render: completionIcon, position: 20 }],
          maxRenderedOptions: 100,
        }),
        highlightActiveLine(),
        highlightSelectionMatches(),
        overlay,
        focused,
        EditorView.focusChangeEffect.of((_state, focusing) => focusEffect.of(focusing)),
        cursorDiagnostic,
        // Tab принимает подсказку, без подсказки — отступ. Выход из редактора:
        // Escape, затем Tab (режим фокуса CodeMirror)
        Prec.high(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
        readOnly.of(EditorState.readOnly.of(config.readOnly)),
        empty.of(placeholder(config.placeholder)),
        attributes.of(EditorView.contentAttributes.of(contentAttributes(config))),
        phrases.of(EditorState.phrases.of(config.phrases)),
        sqlEditorTheme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (update.transactions.every((tr) => !tr.docChanged || tr.annotation(external))) return
          options.onChange(update.state.doc.toString())
        }),
      ],
    }),
  })

  const applyDiagnostics = () =>
    view.dispatch(
      setDiagnostics(view.state, toEditorDiagnostics(view.state.doc.toString(), diagnostics)),
    )
  if (diagnostics.length > 0) applyDiagnostics()

  return {
    setValue(value) {
      const current = view.state.doc.toString()
      if (value === current) return
      // Меняется только отличающаяся середина: курсор и подчёркивания остаются на месте
      let start = 0
      const max = Math.min(current.length, value.length)
      while (start < max && current[start] === value[start]) start += 1
      let end = current.length
      let endValue = value.length
      while (end > start && endValue > start && current[end - 1] === value[endValue - 1]) {
        end -= 1
        endValue -= 1
      }
      view.dispatch({
        changes: { from: start, to: end, insert: value.slice(start, endValue) },
        annotations: external.of(true),
      })
    },
    setConfig(next) {
      const effects: StateEffect<unknown>[] = []
      if (next.readOnly !== config.readOnly) {
        effects.push(readOnly.reconfigure(EditorState.readOnly.of(next.readOnly)))
      }
      if (next.placeholder !== config.placeholder) {
        effects.push(empty.reconfigure(placeholder(next.placeholder)))
      }
      if (next.lineNumbers !== config.lineNumbers) {
        effects.push(numbers.reconfigure(gutter(next.lineNumbers)))
      }
      const nextAttrs = contentAttributes(next)
      const prevAttrs = contentAttributes(config)
      if (!sameRecord(nextAttrs, prevAttrs)) {
        effects.push(attributes.reconfigure(EditorView.contentAttributes.of(nextAttrs)))
      }
      if (!sameRecord(next.phrases, config.phrases)) {
        effects.push(phrases.reconfigure(EditorState.phrases.of(next.phrases)))
      }
      config = next
      if (effects.length > 0) view.dispatch({ effects })
    },
    setCompletion(data) {
      completion = data
    },
    setDiagnostics(list) {
      if (sameDiagnostics(list, diagnostics)) return
      diagnostics = list
      applyDiagnostics()
    },
    focus() {
      view.focus()
    },
    insert(text) {
      if (view.state.readOnly) return
      view.dispatch({
        ...view.state.replaceSelection(text),
        scrollIntoView: true,
        userEvent: 'input',
      })
      view.focus()
    },
    select(from, to = from) {
      const clamp = (value: number) => Math.min(Math.max(0, value), view.state.doc.length)
      view.dispatch({ selection: { anchor: clamp(from), head: clamp(to) }, scrollIntoView: true })
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}
