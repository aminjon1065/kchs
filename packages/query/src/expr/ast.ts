/** Узлы синтаксического дерева выражения; `pos`/`end` — смещения в исходной строке. */
export interface Span {
  pos: number
  end: number
}

export type BinaryOp =
  | 'or'
  | 'and'
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '||'

export type Expr = Span &
  (
    | { kind: 'number'; value: number }
    | { kind: 'string'; value: string }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'null' }
    | { kind: 'field'; qualifier: string | null; name: string }
    | { kind: 'param'; name: string }
    | { kind: 'macro'; name: string }
    | { kind: 'unary'; op: '-' | '+' | 'not'; operand: Expr }
    | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; opPos: number }
    | { kind: 'in'; operand: Expr; list: Expr[]; negated: boolean }
    | { kind: 'isnull'; operand: Expr; negated: boolean }
    | { kind: 'like'; operand: Expr; pattern: Expr; negated: boolean }
    | { kind: 'call'; name: string; args: Expr[] }
    | { kind: 'case'; branches: Array<{ when: Expr; result: Expr }>; otherwise: Expr | null }
  )
