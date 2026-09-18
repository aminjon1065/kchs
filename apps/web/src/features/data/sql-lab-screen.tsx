import type { QueryResult, SqlSchemaTable } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  DataGrid,
  type DataGridColumn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  PanelToolbar,
  quoteSqlIdentifier,
  SearchInput,
  SqlEditor,
  type SqlEditorDiagnostic,
  type SqlEditorHandle,
  type SqlEditorSelection,
  type SqlEditorTable,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronRight, History, Lock, Play, Table2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { sqlSchemaQuery } from './queries.js'

/** Состояние вкладки: текст запроса и значения параметров. */
export type SavedSqlLab = {
  sql?: string
  params?: Record<string, string>
}

/** `{{имя}}` в тексте запроса — поля ввода значений под редактором. */
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g
const HISTORY_SIZE = 30

interface Issue {
  message: string
  position?: number
  hint?: string
}

function placeholderNames(sql: string): string[] {
  return [...new Set([...sql.matchAll(PLACEHOLDER)].map((match) => match[1] as string))]
}

/** История запросов — в браузере пользователя; недоступное хранилище её просто отключает. */
function historyKey(userId: string): string {
  return `kchs:sql-history:${userId}`
}

function loadHistory(userId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(historyKey(userId)) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function saveHistory(userId: string, items: string[]): void {
  try {
    window.localStorage.setItem(historyKey(userId), JSON.stringify(items))
  } catch {
    // Хранилище браузера недоступно — история не сохраняется
  }
}

/**
 * SQL-лаборатория (06-analytics-engine.md §6, P1-E05 S02): SELECT по названиям
 * датасетов и подписям полей с подсказками, параметры `{{имя}}`, история в
 * браузере; результат — с политиками пользователя, ошибки — в тексте запроса.
 */
export function SqlLabScreen({ tabId, savedState }: { tabId: string; savedState?: SavedSqlLab }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const setTabState = useWorkspace((s) => s.setTabState)
  const { data: me } = useQuery(meQuery())
  const allowed = me?.capabilities.includes('data.sql') ?? false
  const { data: schema } = useQuery({ ...sqlSchemaQuery(), enabled: allowed })
  const editorRef = useRef<SqlEditorHandle>(null)
  const [sql, setSql] = useState(savedState?.sql ?? '')
  const [params, setParams] = useState<Record<string, string>>(savedState?.params ?? {})
  const [result, setResult] = useState<QueryResult | null>(null)
  const [diagnostics, setDiagnostics] = useState<SqlEditorDiagnostic[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const userId = me?.user.id

  useEffect(() => {
    if (userId) setHistory(loadHistory(userId))
  }, [userId])

  // Состояние вкладки — с паузой после набора, а не на каждую клавишу: обновление
  // хранилища вкладок перерисовывает оболочку, и при быстром наборе React упирался
  // в предел вложенных обновлений. При уходе с вкладки последний текст сохраняется.
  const latestState = useRef<SavedSqlLab>({ sql, params })
  latestState.current = { sql, params }
  useEffect(() => {
    const timer = window.setTimeout(() => setTabState(tabId, { sql, params }), 400)
    return () => window.clearTimeout(timer)
  }, [tabId, sql, params, setTabState])
  useEffect(() => () => setTabState(tabId, latestState.current), [tabId, setTabState])

  const names = useMemo(() => placeholderNames(sql), [sql])
  const editorParams = useMemo(() => names.map((name) => ({ name })), [names])
  const tables = useMemo<SqlEditorTable[]>(
    () =>
      (schema?.tables ?? []).map((table) => ({
        name: table.name,
        ...(table.space ? { description: table.space } : {}),
        columns: table.columns.map((column) => ({
          key: column.key,
          label: column.label[locale] ?? column.label.ru ?? column.key,
          type: t(`data.types.${column.type}`),
        })),
      })),
    [schema, locale, t],
  )

  const run = useMutation({
    mutationFn: (input: { text: string; offset: number }) => {
      const values: Record<string, unknown> = {}
      for (const name of placeholderNames(input.text)) {
        const value = params[name]?.trim()
        if (value) values[name] = value
      }
      return http.post<QueryResult>('/sql/run', { sql: input.text, params: values })
    },
    onMutate: () => {
      setDiagnostics((current) => (current.length > 0 ? [] : current))
      setFailure(null)
    },
    onSuccess: (data, input) => {
      setResult(data)
      if (!userId) return
      const next = [input.text, ...history.filter((item) => item !== input.text)].slice(
        0,
        HISTORY_SIZE,
      )
      setHistory(next)
      saveHistory(userId, next)
    },
    onError: (error, input) => {
      const issues =
        (error instanceof ApiError
          ? (error.problem.data?.issues as Issue[] | undefined)
          : undefined) ?? []
      const placed = issues.filter((issue) => typeof issue.position === 'number')
      setDiagnostics(
        placed.map((issue) => ({
          from: input.offset + (issue.position as number),
          message: issue.hint ? `${issue.message} (${issue.hint})` : issue.message,
        })),
      )
      setFailure(error instanceof ApiError ? error.message : t('errors.unknown'))
      const first = placed[0]
      if (first) editorRef.current?.select(input.offset + (first.position as number))
    },
  })

  const execute = (text: string, selection: SqlEditorSelection | null) => {
    const part = selection?.text.trim() ? selection : null
    const query = part ? part.text : text
    if (!query.trim()) return
    run.mutate({ text: query, offset: part ? part.from : 0 })
  }

  if (me && !allowed) {
    return (
      <EmptyState
        icon={<Lock />}
        title={t('data.sql.title')}
        description={t('data.sql.noAccess')}
      />
    )
  }

  // Число строк — в подвале таблицы; здесь время, кэш и обрезка
  const status = result
    ? [
        t('data.sql.duration', { ms: formatNumber(Math.round(result.durationMs), {}, { locale }) }),
        ...(result.cached ? [t('data.sql.cached')] : []),
        ...(result.truncated
          ? [t('data.sql.truncated', { count: formatNumber(result.rows.length, {}, { locale }) })]
          : []),
      ].join(' · ')
    : null

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <SchemaPanel
        tables={schema?.tables ?? []}
        truncated={schema?.truncated ?? false}
        onInsert={(text) => editorRef.current?.insert(text)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PanelToolbar
          left={
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<Play className="size-3.5" />}
                loading={run.isPending}
                disabled={!sql.trim()}
                onClick={() => execute(sql, null)}
              >
                {t('data.sql.run')}
              </Button>
              <span className="text-xs text-fg-muted">{t('data.sql.runHint')}</span>
            </>
          }
          right={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<History className="size-3.5" />}
                  disabled={history.length === 0}
                >
                  {t('data.sql.history')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-96">
                <DropdownMenuLabel>{t('data.sql.historyTitle')}</DropdownMenuLabel>
                {history.map((item) => (
                  <DropdownMenuItem
                    key={item}
                    onSelect={() => {
                      setSql(item)
                      setDiagnostics([])
                    }}
                  >
                    <span className="truncate font-mono text-xs">{item.replace(/\s+/g, ' ')}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <div className="flex flex-col gap-3 border-b border-line bg-surface p-3">
          <SqlEditor
            ref={editorRef}
            value={sql}
            onChange={(value) => {
              setSql(value)
              // Позиции ошибок относятся к выполненному тексту; пустой список не пересоздаётся
              setDiagnostics((current) => (current.length > 0 ? [] : current))
            }}
            onRun={execute}
            schema={tables}
            params={editorParams}
            diagnostics={diagnostics}
            placeholder={t('data.sql.placeholder')}
            aria-label={t('data.sql.editor')}
            minHeight={140}
            maxHeight={320}
            autoFocus
          />
          {names.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {names.map((name) => (
                <Field
                  key={name}
                  label={`{{${name}}}`}
                  htmlFor={`${tabId}-param-${name}`}
                  className="w-48"
                >
                  <Input
                    id={`${tabId}-param-${name}`}
                    value={params[name] ?? ''}
                    onChange={(event) =>
                      setParams((current) => ({ ...current, [name]: event.target.value }))
                    }
                    placeholder={t('data.sql.paramEmpty')}
                  />
                </Field>
              ))}
            </div>
          ) : null}
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {result ? (
            <>
              <SqlResultTable result={result} />
              <p
                role="status"
                className="shrink-0 border-t border-line bg-surface px-3 py-1.5 text-xs text-fg-secondary"
              >
                {status}
              </p>
            </>
          ) : (
            <EmptyState
              icon={<Table2 />}
              title={t('data.sql.emptyTitle')}
              description={t('data.sql.emptyHint')}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** Датасеты и поля: щелчок вставляет имя в запрос. */
function SchemaPanel({
  tables,
  truncated,
  onInsert,
}: {
  tables: SqlSchemaTable[]
  truncated: boolean
  onInsert: (text: string) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const query = search.trim().toLowerCase()
  const shown = query ? tables.filter((table) => table.name.toLowerCase().includes(query)) : tables
  return (
    <aside
      aria-label={t('data.sql.schema')}
      className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex"
    >
      <div className="border-b border-line p-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('data.sql.schemaSearch')}
          aria-label={t('data.sql.schemaSearch')}
          className="h-7"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1 text-sm">
        {shown.map((table) => (
          <li key={table.id}>
            <div className="flex items-center">
              <button
                type="button"
                aria-expanded={open === table.id}
                aria-label={t('data.sql.fieldsOf', { name: table.name })}
                onClick={() => setOpen((current) => (current === table.id ? null : table.id))}
                className="flex size-6 shrink-0 items-center justify-center rounded-xs text-fg-muted hover:bg-surface-3"
              >
                <ChevronRight
                  aria-hidden
                  className={open === table.id ? 'size-3.5 rotate-90' : 'size-3.5'}
                />
              </button>
              <button
                type="button"
                title={table.space ?? undefined}
                onClick={() => onInsert(quoteSqlIdentifier(table.name))}
                className="min-w-0 flex-1 truncate rounded-xs px-1.5 py-1 text-left text-fg hover:bg-surface-3"
              >
                {table.name}
              </button>
            </div>
            {open === table.id ? (
              <ul className="ml-6 border-l border-line pl-1">
                {table.columns.map((column) => {
                  const label = column.label[locale] ?? column.label.ru ?? column.key
                  return (
                    <li key={column.key}>
                      <button
                        type="button"
                        onClick={() => onInsert(quoteSqlIdentifier(label))}
                        className="flex w-full items-center gap-2 rounded-xs px-1.5 py-0.5 text-left text-xs hover:bg-surface-3"
                      >
                        <span className="min-w-0 flex-1 truncate text-fg">{label}</span>
                        <span className="shrink-0 text-fg-muted">
                          {t(`data.types.${column.type}`)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {truncated ? (
        <p className="border-t border-line px-3 py-2 text-xs text-fg-muted">
          {t('data.sql.schemaTruncated')}
        </p>
      ) : null}
    </aside>
  )
}

/** Результат: столбцы по номеру — имена в SQL могут повторяться. */
function SqlResultTable({ result }: { result: QueryResult }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const columns = useMemo<DataGridColumn[]>(
    () =>
      result.fields.map((field, index) => ({
        key: `c${index}`,
        label: field.label?.[locale] ?? field.label?.ru ?? field.name,
        type: field.type,
        ...(field.format ? { format: field.format } : {}),
      })),
    [result.fields, locale],
  )
  const rows = useMemo(
    () =>
      result.rows.map((row, index) => ({
        id: String(index),
        values: Object.fromEntries(row.map((value, i) => [`c${i}`, value])),
      })),
    [result.rows],
  )
  return (
    <DataGrid
      aria-label={t('data.sql.result')}
      className="min-h-0 flex-1"
      columns={columns}
      rowCount={rows.length}
      getRow={(index) => rows[index]}
      readOnly
      locale={locale}
    />
  )
}
