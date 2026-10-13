import type { Analysis, ParseTree, TableCatalog } from './analyze/model.js'
import { Analyzer } from './analyze/select.js'
import { type Placeholder, SourcePositions, sqlFail } from './text.js'

/**
 * Проверка и разбор имён сырого SQL по дереву libpg-query (06-analytics-engine.md
 * §6, 17-security.md). Каждый узел дерева проверяется по белому списку типов
 * узлов и их полей: неизвестный узел или поле — отказ. Попутно собираются правки
 * текста: имена датасетов → подзапросы с политиками, имена CTE → служебные,
 * подписи полей → ключи, `{{параметры}}` → `$n`.
 *
 * Каждая ссылка на таблицу (RangeVar) переписывается: на датасет из контекста
 * или на служебное имя CTE `__kchs_cte_N`. Если разбор областей видимости
 * ошибётся, Postgres не найдёт служебное имя и запрос упадёт — но не прочитает
 * таблицу мимо политик.
 */

export type {
  Analysis,
  DatasetRef,
  Edit,
  FieldRef,
  Output,
  ParseTree,
  TableCatalog,
} from './analyze/model.js'

export interface AnalyzeOptions {
  catalog: TableCatalog | null
  placeholders: readonly Placeholder[]
}

/** Проверка оператора и сбор правок; ошибки — `QueryCompileError` с позицией. */
export function analyzeSql(text: string, tree: ParseTree, options: AnalyzeOptions): Analysis {
  const positions = new SourcePositions(text)
  const statements = tree.stmts ?? []
  if (statements.length === 0) sqlFail('Пустой запрос: напишите SELECT', 0)
  if (statements.length > 1) {
    const second = statements[1]
    sqlFail('Разрешён только один оператор', positions.fromByte(second?.stmt_location ?? 0))
  }
  const raw = statements[0] as NonNullable<ParseTree['stmts']>[number]
  const startByte = raw.stmt_location ?? 0
  const start = positions.fromByte(startByte)
  const end = raw.stmt_len ? positions.fromByte(startByte + raw.stmt_len) : text.length
  const analyzer = new Analyzer(text, positions, options.catalog, options.placeholders)
  const outputs = analyzer.statement(raw.stmt, start)
  analyzer.checkPlaceholders(options.placeholders)
  return {
    statement: { start, end },
    edits: analyzer.edits,
    datasets: analyzer.datasets,
    params: analyzer.params,
    systemColumns: analyzer.systemColumns,
    tables: analyzer.tables,
    outputs,
    usesTime: analyzer.usesTime,
    volatile: analyzer.volatile,
  }
}
