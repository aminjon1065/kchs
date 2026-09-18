import { z } from 'zod'
import { isAppError } from '~/shared/errors.js'
import { type AiProviderClient, providerUnavailable } from './types.js'

const ChatCompletion = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
})

/**
 * Свой сервер модели (vLLM, Ollama и т. п.) с OpenAI-совместимым
 * `POST /chat/completions` — вариант on-prem: данные не покидают периметр.
 * Структурированный ответ — `response_format: json_schema`.
 */
export function openAiCompatProvider(options: {
  baseUrl: string
  apiKey?: string
  model: string
  timeoutMs: number
}): AiProviderClient {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    name: 'openai-compat',
    model: options.model,
    async complete(request) {
      let body: z.infer<typeof ChatCompletion>
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: request.maxTokens,
            temperature: 0,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.schemaName,
                schema: z.toJSONSchema(request.schema),
                strict: true,
              },
            },
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
        })
        if (!response.ok) {
          throw providerUnavailable({ provider: 'openai-compat', status: response.status })
        }
        body = ChatCompletion.parse(await response.json())
      } catch (error) {
        if (isAppError(error)) throw error
        throw providerUnavailable(
          { provider: 'openai-compat', type: error instanceof Error ? error.name : typeof error },
          error,
        )
      }
      const choice = body.choices[0]
      return {
        text: choice?.message.content ?? '',
        model: body.model ?? options.model,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        stop: choice?.finish_reason === 'length' ? 'truncated' : 'end',
      }
    },
  }
}
