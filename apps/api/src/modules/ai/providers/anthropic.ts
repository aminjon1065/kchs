import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { type AiProviderClient, providerUnavailable } from './types.js'

/**
 * Anthropic Messages API через официальный SDK: структурированный ответ по
 * JSON-схеме (`output_config.format`), статический системный промпт кэшируется.
 */
export function anthropicProvider(options: {
  apiKey: string
  baseURL?: string
  model: string
  timeoutMs: number
}): AiProviderClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    timeout: options.timeoutMs,
    maxRetries: 2,
  })
  return {
    name: 'anthropic',
    model: options.model,
    async complete(request) {
      let response: Anthropic.Message
      try {
        response = await client.messages.create({
          model: options.model,
          max_tokens: request.maxTokens,
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: request.prompt }],
          output_config: {
            format: { type: 'json_schema', schema: zodOutputFormat(request.schema).schema },
          },
        })
      } catch (error) {
        throw providerUnavailable(
          {
            provider: 'anthropic',
            status: error instanceof Anthropic.APIError ? (error.status ?? null) : null,
            type: error instanceof Error ? error.name : typeof error,
          },
          error,
        )
      }
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      return {
        text,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stop:
          response.stop_reason === 'refusal'
            ? 'refusal'
            : response.stop_reason === 'max_tokens'
              ? 'truncated'
              : 'end',
      }
    },
  }
}
