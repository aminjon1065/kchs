import {
  type AskDataResult,
  type DatasetField,
  type DatasetRecord,
  explorePlanSpec,
  type Locale,
  type QueryIssue,
  type QueryResult,
  type QuerySpec,
} from '@kchs/contracts'
import { AiService, invalidAnswer } from '~/modules/ai/public.js'
import type { UserCtx } from '~/shared/context.js'
import { AppError, errors, isAppError } from '~/shared/errors.js'
import { AskAnswer, answerToPlan, askableFields } from './ask-plan.js'
import { DatasetAccess } from './dataset-access.js'
import { DatasetService } from './dataset-service.js'
import { QueryService } from './query-service.js'

/** Версия инструкции для модели — в аудите, чтобы сравнивать ответы разных версий. */
const ASK_PROMPT_VERSION = 1
/** Вариантов выбора у поля «список» в схеме для модели — не больше. */
const MAX_OPTIONS = 50

const LANGUAGES: Record<Locale, string> = { ru: 'Russian', tg: 'Tajik', en: 'English' }

/**
 * Инструкция модели. Модель видит только схему датасета (поля, подписи, типы,
 * семантику, варианты списков) — ни одной строки данных (ADR-0061, N6).
 */
function systemPrompt(locale: Locale): string {
  return `You translate a user's question about one dataset into a query plan for the analytics engine of kchs, a corporate data platform. You see only the dataset schema, never its rows.

Rules:
- Use only field keys from the schema, exactly as written. Never invent fields.
- The plan is: filter conditions (all combined with AND) -> grouping -> measures (aggregates) -> sort -> limit. Every part is optional.
- Measures: "count" without a field counts rows; "count_distinct" works on any field; "sum", "avg" and "median" need a numeric field (integer, number, decimal, money, percent); "min" and "max" need a numeric, date or datetime field.
- Group by dimension-like fields. For date and datetime fields set "bucket" to year, quarter, month, week or day; for other fields "bucket" is null.
- Operators: eq, neq, contains, not_contains, starts_with (text); lt, lte, gt, gte, between (numbers and dates, dates as YYYY-MM-DD); in, not_in (lists); is_empty, not_empty (no value); is_true, is_false (boolean fields); relative (date and datetime fields, a period relative to the current one: this month {"unit":"month","from":0,"to":0}, last month {"unit":"month","from":-1,"to":-1}, the last 12 months {"unit":"month","from":-11,"to":0}).
- For fields with "options" compare with the option "value", not with its label.
- Put a single value into "value"; lists (in, not_in) and [from, to] pairs (between) into "values"; the relative period into "relative". Set unused ones to null.
- To sort by a measure use its alias: "count" for a row count, otherwise "<agg>_<field>", for example "sum_amount"; to sort by a grouping use its field key.
- Use "limit" for "top N" questions; otherwise null.
- "chart": "number" for a single value, "bar" to compare categories, "line" or "area" for trends over time, "pie" for shares of a whole with few categories, "table" for detailed lists.
- If the question cannot be answered from this dataset, set "answerable" to false, explain why in "reason" and leave the plan empty.
- Write "title" (a short chart title), "explanation" (one sentence: how you understood the question, with its filters and grouping) and "reason" in ${LANGUAGES[locale]}.`
}

/** Схема для модели: только видимые пользователю поля, без строк данных. */
function schemaFor(record: DatasetRecord, fields: DatasetField[], locale: Locale) {
  const visible = new Set(fields.map((field) => field.key))
  const label = (field: DatasetField) => field.label[locale] ?? field.label.ru ?? field.key
  return {
    dataset: {
      name: record.name,
      description: record.description?.slice(0, 500) ?? null,
      timeField: record.timeField && visible.has(record.timeField) ? record.timeField : null,
    },
    fields: fields.map((field) => ({
      key: field.key,
      label: label(field),
      type: field.type,
      semantic: field.semantic,
      ...(field.unit ? { unit: field.unit } : {}),
      ...(field.description ? { description: field.description.slice(0, 200) } : {}),
      ...(field.options?.length && !field.sensitive
        ? {
            options: field.options.slice(0, MAX_OPTIONS).map((option) => ({
              value: option.value,
              label: option.label[locale] ?? option.label.ru,
            })),
          }
        : {}),
    })),
  }
}

/** Сегодняшняя дата по поясу пользователя — для «за прошлый месяц» и т. п. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** Запрос по плану модели: ошибка компиляции — ответ модели не годится, а не ошибка пользователя. */
async function runPlanQuery(ctx: UserCtx, spec: QuerySpec): Promise<QueryResult> {
  try {
    return await QueryService.run(ctx, spec)
  } catch (error) {
    if (isAppError(error) && error.code === 'validation_failed') {
      const issues = (error.data?.issues as QueryIssue[] | undefined)?.map((issue) => issue.message)
      throw invalidAnswer('Запрос по вопросу не прошёл проверку', issues ?? [error.message])
    }
    throw error
  }
}

/**
 * «Спросить данные» v1 (P1-E09 S03): вопрос → план от модели → проверка по
 * схеме, видимой пользователю → QuerySpec → компилятор с его политиками строк
 * и столбцов → результат. Невалидный ответ модели не выполняется.
 */
export const AskService = {
  async ask(ctx: UserCtx, datasetId: string, question: string): Promise<AskDataResult> {
    const grant = await DatasetAccess.resolve(ctx, datasetId)
    const record = await DatasetService.get(datasetId)
    const fields = askableFields(record.fields, grant.hidden, grant.masked)
    if (fields.length === 0) throw errors.validation('В датасете нет полей, доступных для вопросов')

    const prompt = [
      `Today is ${todayIn(ctx.timezone)} (time zone ${ctx.timezone}).`,
      'Dataset schema (JSON):',
      JSON.stringify(schemaFor(record, fields, ctx.locale)),
      '',
      `Question: ${question}`,
    ].join('\n')

    return AiService.complete(
      ctx,
      {
        feature: 'ask_data',
        system: systemPrompt(ctx.locale),
        prompt,
        schema: AskAnswer,
        schemaName: 'ask_data_plan',
        maxTokens: 2048,
        object: { id: datasetId, type: 'dataset' },
        details: {
          question,
          promptVersion: ASK_PROMPT_VERSION,
          schemaVersion: record.schemaVersion,
          fields: fields.length,
        },
      },
      async (answer) => {
        const converted = answerToPlan(answer, fields)
        if (!converted.ok) {
          if (converted.kind === 'unanswerable') {
            throw new AppError(
              'validation_failed',
              converted.message || 'По этому датасету на вопрос не ответить',
              422,
              { data: { reason: 'ai_unanswerable' } },
            )
          }
          throw invalidAnswer('Модель построила недопустимый запрос', converted.issues)
        }
        const spec = explorePlanSpec(datasetId, converted.plan)
        const result = await runPlanQuery(ctx, spec)
        return {
          plan: converted.plan,
          spec,
          chart: converted.chart,
          title: converted.title,
          explanation: converted.explanation,
          result,
        }
      },
    )
  },
}
