import type { DiffOp, DiffSegment } from '@kchs/contracts'

/**
 * Сравнение текста по словам (08-documents.md §8): алгоритм Майерса O((N+M)·D)
 * над словами и промежутками. Общие начало и конец отбрасываются сразу —
 * у версий документа они почти всегда совпадают; если различий больше
 * `maxEdits`, середина показывается целиком как «удалено / добавлено».
 */

/** Слова и промежутки между ними; промежутки равны друг другу независимо от вида. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

const isSpace = (token: string) => /^\s+$/.test(token)

function same(a: string, b: string): boolean {
  return a === b || (isSpace(a) && isSpace(b))
}

interface Edit {
  op: DiffOp
  token: string
}

/**
 * Кратчайший сценарий правки середины; null — различий больше `maxEdits`.
 * Фронт шага d хранится только в диапазоне диагоналей [-d, d]: память O(D²).
 */
function myers(a: string[], b: string[], maxEdits: number): Edit[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && same(a[x] ?? '', b[y] ?? '')) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found < 0) return null

  // Фронт шага d по диагонали k (диагонали вне [-d, d] на этом шаге не нужны)
  const at = (d: number, k: number) => trace[d]?.[k + d] ?? 0
  // Обратный проход по сохранённым фронтам: от (n, m) к началу
  const edits: Edit[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const k = x - y
    const down = k === -d || (k !== d && at(d - 1, k - 1) < at(d - 1, k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(d - 1, prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      edits.push({ op: 'equal', token: b[y] ?? '' })
    }
    if (down) {
      y -= 1
      edits.push({ op: 'insert', token: b[y] ?? '' })
    } else {
      x -= 1
      edits.push({ op: 'delete', token: a[x] ?? '' })
    }
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    edits.push({ op: 'equal', token: b[y] ?? '' })
  }
  return edits.reverse()
}

/**
 * Сегменты для чтения: соседние правки, разделённые только пробелом, — одна
 * правка («три машины» → «пять машин», а не четыре обрывка); пробел при этом
 * входит в обе стороны, и обе стороны по-прежнему собираются из сегментов.
 */
function merge(edits: Edit[]): DiffSegment[] {
  const segments: DiffSegment[] = []
  const push = (op: DiffOp, text: string) => {
    if (!text) return
    const last = segments.at(-1)
    if (last && last.op === op) last.text += text
    else segments.push({ op, text })
  }
  let index = 0
  while (index < edits.length) {
    const edit = edits[index]
    if (!edit) break
    if (edit.op === 'equal') {
      push('equal', edit.token)
      index += 1
      continue
    }
    let removed = ''
    let added = ''
    while (index < edits.length) {
      const current = edits[index]
      if (!current) break
      if (current.op === 'delete') removed += current.token
      else if (current.op === 'insert') added += current.token
      else if (isSpace(current.token) && edits[index + 1] && edits[index + 1]?.op !== 'equal') {
        removed += current.token
        added += current.token
      } else break
      index += 1
    }
    push('delete', removed)
    push('insert', added)
  }
  return segments
}

export interface TextDiff {
  segments: DiffSegment[]
  stats: { inserted: number; deleted: number; unchanged: number }
}

export function diffText(from: string, to: string, maxEdits = 2000): TextDiff {
  const a = tokenize(from)
  const b = tokenize(to)
  let start = 0
  while (start < a.length && start < b.length && same(a[start] ?? '', b[start] ?? '')) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && same(a[endA - 1] ?? '', b[endB - 1] ?? '')) {
    endA -= 1
    endB -= 1
  }
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  const middle = myers(middleA, middleB, maxEdits) ?? [
    ...middleA.map((token) => ({ op: 'delete' as const, token })),
    ...middleB.map((token) => ({ op: 'insert' as const, token })),
  ]
  const edits: Edit[] = [
    ...b.slice(0, start).map((token) => ({ op: 'equal' as const, token })),
    ...middle,
    ...b.slice(endB).map((token) => ({ op: 'equal' as const, token })),
  ]
  const stats = { inserted: 0, deleted: 0, unchanged: 0 }
  for (const edit of edits) {
    if (isSpace(edit.token)) continue
    if (edit.op === 'insert') stats.inserted += 1
    else if (edit.op === 'delete') stats.deleted += 1
    else stats.unchanged += 1
  }
  return { segments: merge(edits), stats }
}
