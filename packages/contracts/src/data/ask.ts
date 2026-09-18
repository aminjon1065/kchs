import { z } from 'zod'
import { ChartType } from './chart.js'
import { ExplorePlan } from './explore.js'
import { QueryResult, QuerySpec } from './query.js'

/**
 * «Спросить данные» v1 (P1-E09 S03, ADR-0061): вопрос на естественном языке →
 * план «Исследования» от модели → проверка контрактом и компилятором с
 * политиками пользователя → результат. Запрос показывается и правится вручную.
 */
export const AskDataInput = z.object({
  question: z.string().trim().min(3).max(500),
})
export type AskDataInput = z.infer<typeof AskDataInput>

/** Типы графика, которые предлагает «Спросить данные». */
export const ASK_CHART_TYPES = ['table', 'number', 'bar', 'line', 'area', 'pie'] as const

export const AskDataResult = z.object({
  plan: ExplorePlan,
  spec: QuerySpec,
  chart: ChartType,
  /** Короткое название ответа — подпись графика. */
  title: z.string(),
  /** Как модель поняла вопрос — показывается рядом с запросом. */
  explanation: z.string(),
  result: QueryResult,
})
export type AskDataResult = z.infer<typeof AskDataResult>
