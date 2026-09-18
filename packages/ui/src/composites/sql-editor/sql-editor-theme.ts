import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/**
 * Тема SqlEditor из токенов дизайн-системы. Цвета — только CSS-переменные
 * (`--bg-*`, `--text*`, `--accent*`, семантические): смена `data-theme` на <html>
 * или на контейнере перекрашивает редактор без пересоздания и перенастройки.
 * Поэтому тема не помечается тёмной, а все правила базовых тем CodeMirror с
 * зашитыми цветами (`&light …`) здесь перекрыты. Полупрозрачные подложки — токен
 * с прозрачностью через color-mix, как модификатор `/40` у Tailwind.
 *
 * Шрифт и кегль задаёт обёртка (`font-mono text-sm`), редактор их наследует.
 * Высоту задают переменные `--sql-editor-*` на обёртке (см. sql-editor.tsx).
 */

const translucent = (token: string, percent: number) =>
  `color-mix(in oklab, var(${token}) ${percent}%, transparent)`

/**
 * Радиусы и кегль — переменные темы Tailwind (theme.css) с запасным значением:
 * Tailwind выводит переменную, только когда её где-то использует утилита или CSS.
 */
const radius = {
  xs: 'var(--radius-xs, 4px)',
  sm: 'var(--radius-sm, 6px)',
  md: 'var(--radius-md, 8px)',
}
const textXs = { fontSize: 'var(--text-xs, 12px)', lineHeight: 'var(--text-xs--line-height, 16px)' }

const panelControl = {
  height: '28px',
  margin: 0,
  padding: '0 8px',
  border: '1px solid var(--border-strong)',
  borderRadius: radius.sm,
  backgroundColor: 'var(--bg-surface)',
  backgroundImage: 'none',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: textXs.fontSize,
  verticalAlign: 'middle',
}

export const sqlEditorTheme = EditorView.theme({
  '&': {
    height: 'var(--sql-editor-height, auto)',
    minHeight: 'var(--sql-editor-min-height, 0)',
    maxHeight: 'var(--sql-editor-max-height, none)',
    color: 'var(--text)',
    backgroundColor: 'transparent',
  },
  // Фокус показывает рамка обёртки (base.css, [data-field]) — свой контур не нужен
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '8px 0',
    caretColor: 'var(--text)',
  },
  '.cm-content, .cm-gutter': { minHeight: 'var(--sql-editor-min-height, 0)' },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-specialChar': { color: 'var(--danger)' },

  // Курсор, выделение, текущая строка
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--text)', marginLeft: '-1px' },
  '.cm-selectionBackground': { background: 'var(--bg-surface-3)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'var(--accent-subtle)',
  },
  // Строка поверх слоя выделения: подложка полупрозрачная, чтобы выделение было видно
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: translucent('--bg-surface-3', 50) },
  '.cm-selectionMatch': { backgroundColor: translucent('--accent-subtle', 70) },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-subtle)',
    outline: `1px solid ${translucent('--accent', 40)}`,
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'var(--danger-subtle)',
    color: 'var(--danger)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--warning-subtle)',
    outline: `1px solid ${translucent('--warning', 50)}`,
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent-subtle)',
    outline: '1px solid var(--accent)',
  },

  // Номера строк
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
  },
  '.cm-gutters.cm-gutters-before': { borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '32px',
    padding: '0 8px 0 12px',
    fontSize: textXs.fontSize,
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': { color: 'var(--text-secondary)' },

  // Параметры {{name}} и имена на любом алфавите (оверлей подсветки)
  '.cm-sqlParam': {
    color: 'var(--purple)',
    backgroundColor: 'var(--purple-subtle)',
    borderRadius: radius.xs,
  },
  '.cm-sqlName': { color: 'var(--text)' },

  // Всплывающие окна: подсказки, ошибки
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    borderRadius: radius.md,
    backgroundColor: 'var(--bg-overlay)',
    color: 'var(--text)',
    boxShadow: 'var(--elevation-md)',
  },
  '.cm-tooltip-section:not(:first-child)': { borderTop: '1px solid var(--border)' },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    minWidth: '240px',
    maxWidth: 'min(560px, 95vw)',
    maxHeight: '240px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '28px',
    padding: '4px 8px',
    borderRadius: radius.xs,
    lineHeight: '20px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-subtle)',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete-disabled ul li[aria-selected]': {
    backgroundColor: 'var(--bg-surface-3)',
  },
  '.cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after': {
    color: 'var(--text-muted)',
    opacity: 1,
  },
  '.cm-completionIcon': {
    display: 'inline-flex',
    flex: 'none',
    width: '14px',
    padding: 0,
    color: 'var(--text-muted)',
    opacity: 1,
  },
  '.cm-completionLabel': {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    fontWeight: 600,
    color: 'var(--accent)',
  },
  '.cm-completionDetail': {
    flex: 'none',
    marginLeft: 'auto',
    paddingLeft: '12px',
    fontStyle: 'normal',
    fontSize: textXs.fontSize,
    color: 'var(--text-muted)',
  },
  '.cm-tooltip.cm-completionInfo': {
    maxWidth: '320px',
    padding: '8px 12px',
    fontFamily: 'var(--font-sans)',
    ...textXs,
    color: 'var(--text-secondary)',
  },

  // Ошибки: волнистое подчёркивание цветом токена вместо картинки с зашитым цветом
  '.cm-lintRange': {
    backgroundImage: 'none',
    paddingBottom: 0,
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationThickness: '1px',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecorationColor: 'var(--danger)' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecorationColor: 'var(--warning)' },
  '.cm-lintRange-info, .cm-lintRange-hint': {
    backgroundImage: 'none',
    textDecorationColor: 'var(--info)',
  },
  '.cm-lintRange-active': { backgroundColor: 'var(--danger-subtle)' },
  '.cm-lintPoint:after': { borderBottomColor: 'var(--danger)' },
  '.cm-lintPoint-warning:after': { borderBottomColor: 'var(--warning)' },
  '.cm-lintPoint-info:after, .cm-lintPoint-hint:after': { borderBottomColor: 'var(--info)' },
  '.cm-tooltip-lint': {
    maxWidth: '400px',
    padding: '4px 0',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-diagnostic': {
    padding: '4px 12px 4px 10px',
    marginLeft: 0,
    borderLeft: '2px solid var(--danger)',
    ...textXs,
    color: 'var(--text)',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-diagnostic-info, .cm-diagnostic-hint': { borderLeftColor: 'var(--info)' },
  '.cm-diagnosticSource': { color: 'var(--text-muted)', opacity: 1 },

  // Панели: поиск и замена (⌘F), переход к строке, список ошибок (⌘⇧M)
  '.cm-panels': {
    backgroundColor: 'var(--bg-surface-2)',
    color: 'var(--text)',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search, .cm-dialog': {
    padding: '4px 40px 4px 8px',
    fontSize: textXs.fontSize,
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label, .cm-dialog input, .cm-dialog button':
    { margin: '4px 8px 4px 0' },
  '.cm-panel.cm-search label, .cm-dialog label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: textXs.fontSize,
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap',
  },
  '.cm-panel.cm-search input[type=checkbox]': { margin: 0, accentColor: 'var(--accent)' },
  '.cm-textfield': panelControl,
  '.cm-textfield:focus': { borderColor: 'var(--accent)' },
  '.cm-button': {
    ...panelControl,
    padding: '0 10px',
    fontWeight: 500,
    cursor: 'pointer',
  },
  '.cm-button:hover, .cm-button:active': {
    backgroundColor: 'var(--bg-surface-3)',
    backgroundImage: 'none',
  },
  '.cm-panel.cm-search [name=close], .cm-dialog-close, .cm-panel.cm-panel-lint [name=close]': {
    position: 'absolute',
    top: '8px',
    right: '8px',
    width: '24px',
    height: '24px',
    padding: 0,
    border: 'none',
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    font: 'inherit',
    fontSize: 'var(--text-md, 16px)',
    lineHeight: '24px',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover, .cm-dialog-close:hover, .cm-panel.cm-panel-lint [name=close]:hover':
    {
      backgroundColor: 'var(--bg-surface-3)',
      color: 'var(--text)',
    },
  '.cm-panel.cm-panel-lint ul': { maxHeight: '120px' },
  '.cm-panel.cm-panel-lint ul [aria-selected]': {
    backgroundColor: 'var(--bg-surface-3)',
    color: 'var(--text)',
  },
  '.cm-panel.cm-panel-lint ul:focus [aria-selected]': {
    backgroundColor: 'var(--accent-subtle)',
    color: 'var(--text)',
  },
})

/**
 * Подсветка синтаксиса: ключевые слова — акцент, строки — success, числа и
 * литералы — warning, типы — purple, комментарии — muted. Контраст этих токенов
 * на поверхностях проверяет `pnpm --filter @kchs/ui contrast`. Идентификатор в
 * кавычках — обычный текст: это имя, а не строка.
 */
export const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent)' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--purple)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning)' },
  { tag: tags.string, color: 'var(--success)' },
  { tag: tags.special(tags.string), color: 'var(--text)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--text-muted)' },
  {
    tag: [tags.operator, tags.punctuation, tags.paren, tags.brace, tags.squareBracket],
    color: 'var(--text-secondary)',
  },
])
