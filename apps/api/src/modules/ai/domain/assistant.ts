import {
  ASSISTANT_MAX_STEPS,
  type AssistantCitation,
  type AssistantMessage,
  type AssistantProposal,
  AssistantProposal as AssistantProposalSchema,
  type AssistantStep,
  type AssistantThread,
  AssistantTool,
} from '@kchs/contracts'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { objectType } from '~/kernel/objects/registry.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { search, similar } from '~/kernel/search/index-service.js'
import { AskData } from '~/modules/data/public.js'
import { fileText } from '~/modules/files/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { assistantMessages, assistantThreads, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { AiService } from './service.js'

/**
 * Ассистент в контекстной панели (13-search-knowledge-ai.md §5, ADR-0100):
 * модель решает, каким инструментом воспользоваться, сервер выполняет
 * инструмент правами пользователя и отдаёт результат модели обратно. Создание
 * объектов ассистент не выполняет — только предлагает.
 */

/** Сколько сообщений диалога помним: хвост важнее начала. */
const HISTORY = 12
/** Предел текста одного результата инструмента в промпте. */
const TOOL_CHARS = 4000

/** Решение модели: шаг инструментом или готовый ответ. */
const Decision = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('tool'),
    tool: AssistantTool,
    /** Поисковый запрос для `search`. */
    query: z.string().max(300).default(''),
    /** Объект для `get_object`, `similar`, `file_text`. */
    objectId: z.string().max(64).default(''),
    /** Зачем этот шаг — показывается пользователю. */
    reason: z.string().max(200).default(''),
  }),
  z.object({
    action: z.literal('answer'),
    text: z.string().max(4000),
    /** Идентификаторы объектов, на которые опирается ответ. */
    citations: z.array(z.string().max(64)).max(8).default([]),
    proposals: z.array(AssistantProposalSchema).max(3).default([]),
  }),
])
type Decision = z.infer<typeof Decision>

const SYSTEM = [
  'Ты — помощник корпоративной платформы. Отвечай по-русски, коротко и по делу.',
  'Ты видишь только то, что доступно спрашивающему: если инструмент ничего не вернул, так и скажи.',
  'Ничего не выдумывай: факты бери из результатов инструментов и ссылайся на объекты их идентификаторами.',
  'Инструменты: search (поиск по названию и смыслу), similar (похожие на объект),',
  'get_object (карточка объекта), file_text (извлечённый текст файла),',
  'ask_data (вопрос к датасету на русском: objectId — датасет, query — вопрос).',
  'Когда данных достаточно — отвечай (action: "answer").',
  'Если нужно создать поручение или документ — предложи его в proposals, не выполняй сам.',
].join(' ')

interface ToolOutcome {
  step: AssistantStep
  text: string
  citations: AssistantCitation[]
}

/** Подсветка поиска (`<mark>`) — разметка выдачи, а не текст объекта. */
const plain = (value: string): string => value.replaceAll('<mark>', '').replaceAll('</mark>', '')

function citationOf(hit: {
  objectId: string
  type: string
  title: string
  url: string
  snippet: string | null
}): AssistantCitation {
  return {
    objectId: hit.objectId,
    type: hit.type,
    title: plain(hit.title),
    url: hit.url,
    snippet: hit.snippet === null ? null : plain(hit.snippet),
  }
}

/** Выполняет инструмент правами пользователя: чужого он не увидит. */
async function runTool(
  ctx: UserCtx,
  decision: Decision & { action: 'tool' },
): Promise<ToolOutcome> {
  const none = (summary: string): ToolOutcome => ({
    step: { tool: decision.tool, summary, found: 0 },
    text: 'ничего не найдено',
    citations: [],
  })

  if (decision.tool === 'search') {
    const query = decision.query.trim()
    if (!query) return none('поиск без запроса')
    const result = await search(ctx, { q: query, limit: 8, offset: 0, mode: 'hybrid' })
    const citations = result.hits.map(citationOf)
    return {
      step: { tool: 'search', summary: `искал: ${query}`, found: citations.length },
      text: citations.length
        ? citations
            .map((hit) => `- ${hit.title} (${hit.type}, id=${hit.objectId}): ${hit.snippet ?? ''}`)
            .join('\n')
            .slice(0, TOOL_CHARS)
        : 'ничего не найдено',
      citations,
    }
  }

  const objectId = decision.objectId.trim()
  if (!objectId) return none('шаг без объекта')
  try {
    await authorize(ctx, 'view', objectId)
  } catch {
    return none('объект недоступен')
  }

  if (decision.tool === 'similar') {
    const hits = await similar(ctx, objectId, 6)
    const citations = hits.map(citationOf)
    return {
      step: { tool: 'similar', summary: 'искал похожие', found: citations.length },
      text: citations.length
        ? citations.map((hit) => `- ${hit.title} (id=${hit.objectId})`).join('\n')
        : 'похожих не нашлось',
      citations,
    }
  }

  if (decision.tool === 'get_object') {
    const summaries = await ObjectService.summaries([objectId])
    const summary = summaries.get(objectId)
    if (!summary) return none('карточка недоступна')
    const definition = objectType(summary.type)
    const citation: AssistantCitation = {
      objectId,
      type: summary.type,
      title: summary.title,
      url: definition?.route(objectId) ?? `/o/${objectId}`,
      snippet: summary.subtitle ?? null,
    }
    return {
      step: { tool: 'get_object', summary: `смотрел карточку «${summary.title}»`, found: 1 },
      text: JSON.stringify({
        id: objectId,
        type: summary.type,
        title: summary.title,
        subtitle: summary.subtitle,
        updatedAt: summary.updatedAt,
        meta: summary.meta,
      }).slice(0, TOOL_CHARS),
      citations: [citation],
    }
  }

  if (decision.tool === 'ask_data') {
    const question = decision.query.trim() || 'покажи сводку'
    try {
      const answer = await AskData.ask(ctx, objectId, question)
      const rows = answer.result.rows.slice(0, 20)
      return {
        step: { tool: 'ask_data', summary: `спросил данные: ${question}`, found: rows.length },
        text: JSON.stringify({
          title: answer.title,
          explanation: answer.explanation,
          fields: answer.result.fields.map((field) => field.name),
          rows,
        }).slice(0, TOOL_CHARS),
        citations: [],
      }
    } catch (error) {
      return none(error instanceof Error ? error.message.slice(0, 120) : 'данные не ответили')
    }
  }

  const extracted = await fileText(objectId, TOOL_CHARS)
  const text = extracted.status === 'ready' ? (extracted.text ?? '') : ''
  if (!text) return none('текста файла нет')
  const [row] = await db()
    .select({ title: objects.title, type: objects.type })
    .from(objects)
    .where(eq(objects.id, objectId))
    .limit(1)
  return {
    step: { tool: 'file_text', summary: 'читал текст файла', found: 1 },
    text: text.slice(0, TOOL_CHARS),
    citations: row
      ? [
          {
            objectId,
            type: row.type,
            title: row.title,
            url: `/o/${objectId}`,
            snippet: null,
          },
        ]
      : [],
  }
}

async function threadOf(ctx: UserCtx, objectId: string | null): Promise<string> {
  const [existing] = await db()
    .select({ id: assistantThreads.id })
    .from(assistantThreads)
    .where(
      and(
        eq(assistantThreads.userId, ctx.userId),
        objectId ? eq(assistantThreads.objectId, objectId) : isNull(assistantThreads.objectId),
      ),
    )
    .orderBy(desc(assistantThreads.updatedAt))
    .limit(1)
  if (existing) return existing.id
  const id = newId()
  await db().insert(assistantThreads).values({ id, userId: ctx.userId, objectId })
  return id
}

async function historyOf(threadId: string): Promise<AssistantMessage[]> {
  const rows = await db()
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.threadId, threadId))
    .orderBy(asc(assistantMessages.createdAt))
  return rows.slice(-HISTORY).map((row) => ({
    id: row.id,
    role: row.role as AssistantMessage['role'],
    text: row.text,
    steps: row.steps,
    citations: row.citations,
    proposals: row.proposals,
    createdAt: row.createdAt,
  }))
}

export const Assistant = {
  /** История диалога по объекту (или общего) — только своя. */
  async thread(ctx: UserCtx, objectId: string | null): Promise<AssistantThread> {
    if (objectId) await authorize(ctx, 'view', objectId)
    const id = await threadOf(ctx, objectId)
    return { id, objectId, messages: await historyOf(id) }
  },

  /** Очистить диалог: пользователь стирает свою переписку. */
  async clear(ctx: UserCtx, threadId: string): Promise<void> {
    const [thread] = await db()
      .select({ userId: assistantThreads.userId })
      .from(assistantThreads)
      .where(eq(assistantThreads.id, threadId))
      .limit(1)
    if (!thread) throw errors.notFound('Диалог')
    if (thread.userId !== ctx.userId) throw errors.notFound('Диалог')
    await db().delete(assistantThreads).where(eq(assistantThreads.id, threadId))
  },

  /**
   * Вопрос ассистенту: модель либо просит инструмент, либо отвечает. Цикл
   * ограничен `ASSISTANT_MAX_STEPS` — ассистент не ходит по кругу.
   */
  async ask(
    ctx: UserCtx,
    input: { objectId: string | null; question: string },
  ): Promise<AssistantMessage> {
    if (input.objectId) await authorize(ctx, 'view', input.objectId)
    const threadId = await threadOf(ctx, input.objectId)
    const history = await historyOf(threadId)

    const context: string[] = []
    if (input.objectId) {
      const summary = (await ObjectService.summaries([input.objectId])).get(input.objectId)
      if (summary) {
        context.push(
          `Открытый объект: ${summary.title} (${summary.type}, id=${input.objectId})`,
          summary.subtitle ? `Подпись: ${summary.subtitle}` : '',
        )
      }
    }
    for (const message of history) {
      context.push(`${message.role === 'user' ? 'Вопрос' : 'Ответ'}: ${message.text}`)
    }
    context.push(`Вопрос: ${input.question}`)

    const steps: AssistantStep[] = []
    const citations = new Map<string, AssistantCitation>()
    let answer: (Decision & { action: 'answer' }) | null = null

    for (let attempt = 0; attempt <= ASSISTANT_MAX_STEPS && !answer; attempt += 1) {
      const last = attempt === ASSISTANT_MAX_STEPS
      const decision = await AiService.complete<Decision, Decision>(
        ctx,
        {
          feature: 'assistant',
          system: last ? `${SYSTEM} Шаги закончились — отвечай тем, что есть.` : SYSTEM,
          prompt: context.join('\n'),
          schema: Decision,
          schemaName: 'AssistantDecision',
          maxTokens: 1500,
          ...(input.objectId ? { object: { id: input.objectId, type: 'object' } } : {}),
          details: { step: attempt },
          auditAnswer: false,
        },
        async (value) => value,
      )

      if (decision.action === 'answer') {
        answer = decision
        break
      }
      const outcome = await runTool(ctx, decision)
      steps.push({ ...outcome.step, summary: decision.reason || outcome.step.summary })
      for (const citation of outcome.citations) citations.set(citation.objectId, citation)
      context.push(`Результат инструмента ${decision.tool}: ${outcome.text}`)
    }

    const used = answer
      ? answer.citations
          .map((id) => citations.get(id))
          .filter((item): item is AssistantCitation => Boolean(item))
      : []
    const message: AssistantMessage = {
      id: newId(),
      role: 'assistant',
      text: answer?.text ?? 'Не удалось собрать ответ — попробуйте переформулировать вопрос.',
      steps,
      citations: used.length > 0 ? used : [...citations.values()].slice(0, 3),
      proposals: (answer?.proposals ?? []) as AssistantProposal[],
      createdAt: new Date().toISOString(),
    }

    await db().transaction(async (tx) => {
      await tx.insert(assistantMessages).values({
        id: newId(),
        threadId,
        role: 'user',
        text: input.question,
      })
      await tx.insert(assistantMessages).values({
        id: message.id,
        threadId,
        role: 'assistant',
        text: message.text,
        steps: message.steps,
        citations: message.citations,
        proposals: message.proposals,
      })
      await tx
        .update(assistantThreads)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(assistantThreads.id, threadId))
    })

    return message
  },
}
