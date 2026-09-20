/**
 * @kchs/query — язык выражений, компилятор QuerySpec → SQL и сырой SQL лаборатории
 * (contracts/query-spec.md, 06-analytics-engine.md §5). Чистый пакет: без
 * базы и сети; вызывающий загружает датасеты с политиками пользователя,
 * компилирует и выполняет SQL под ролью `kchs_query`.
 */
export { checkExpression, type ExpressionCheck, type ExpressionCheckResult } from './check.js'
export { collectSources } from './collect.js'
export {
  cacheKeyText,
  compileQuery,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
} from './compiler/compile.js'
export { DEFAULT_TIMEZONE } from './compiler/state.js'
export { type Dialect, duckdbDialect, postgresDialect } from './dialect.js'
export { ExpressionError, QueryCompileError, UnsupportedByDialectError } from './errors.js'
export type { Expr } from './expr/ast.js'
export {
  type CompiledExpr,
  compileCondition,
  compileExpression,
  type ExprEnv,
  type ExprField,
  type ExprValue,
} from './expr/compile.js'
export { parseExpression } from './expr/parser.js'
export { ParamBinder } from './params.js'
export { MissingReferencesError, referenceKey } from './references.js'
export { compileRawSql, rawSqlErrorPosition, rawSqlTables } from './sql/compile.js'
export type {
  CacheKeyParts,
  CollectedSources,
  ColumnPolicy,
  CompileContext,
  CompiledQuery,
  CompiledRawSql,
  CompileUser,
  LookupRef,
  RawSqlColumn,
  RawSqlContext,
  ReferenceMap,
  ReferenceRequest,
  ResolvedDataset,
  ResolvedField,
  RowPolicy,
  SpatialWindow,
  SqlDataset,
  SqlSourceSegment,
} from './types.js'
export type { ValueType } from './value-types.js'
