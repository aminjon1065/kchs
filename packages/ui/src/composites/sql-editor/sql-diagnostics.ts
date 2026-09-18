import type { Diagnostic } from '@codemirror/lint'
import { lexSql } from './sql-lexer.js'
import type { SqlEditorDiagnostic } from './types.js'

/**
 * Диагностика экрана → диагностика CodeMirror. Сервер обычно знает только
 * позицию ошибки разбора: без `to` подчёркивается токен в этой позиции (слово,
 * строка, число — в пределах строки), а в конце текста — точка.
 */
export function toEditorDiagnostics(
  text: string,
  list: readonly SqlEditorDiagnostic[],
): Diagnostic[] {
  const tokens = list.some((item) => item.to === undefined || item.to <= item.from)
    ? lexSql(text)
    : []
  const clamp = (value: number, min: number) =>
    Math.min(Math.max(Math.trunc(Number.isFinite(value) ? value : 0), min), text.length)
  return list.map((item) => {
    const from = clamp(item.from, 0)
    let to = clamp(item.to ?? from, from)
    if (to === from) {
      const lineEnd = text.indexOf('\n', from)
      const limit = lineEnd < 0 ? text.length : lineEnd
      const token = tokens.find((candidate) => candidate.from <= from && from < candidate.to)
      if (token) to = Math.min(token.to, Math.max(limit, from + 1))
      else if (from < limit) to = from + 1
    }
    return { from, to, severity: item.severity ?? 'error', message: item.message }
  })
}
