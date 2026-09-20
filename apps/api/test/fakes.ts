import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Поддельные внешние сервисы для интеграционных тестов: настоящий Telegram и
 * провайдеры ИИ не вызываются (ADR-0061). Адреса подставляются через
 * TELEGRAM_API_URL, ANTHROPIC_BASE_URL и OPENAI_COMPAT_URL.
 */

interface Recorded {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { raw: text }
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) =>
      send(response, 500, { error: String(error) }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Текстовые поля тела multipart/form-data (файл Bot API шлёт так, а не JSON). */
function multipartFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const pattern = /name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    fields[match[1] as string] = match[2] as string
  }
  return fields
}

// ─── Telegram Bot API ────────────────────────────────────────────────────────

export const FAKE_BOT_USERNAME = 'kchs_test_bot'

export interface FakeTelegram {
  url: string
  token: string
  calls: Recorded[]
  /** Отправленные ботом сообщения: чат и текст. */
  sent(): Array<{ chatId: number; text: string; markup: unknown }>
  /** Файлы, отправленные ботом (sendDocument, multipart): чат, имя, подпись, PDF ли это. */
  documents(): Array<{ chatId: number; fileName: string; caption: string; pdf: boolean }>
  /** Чат «заблокировал бота»: sendMessage отвечает 403. */
  block(chatId: number): void
  /** Обновление для долгого опроса (getUpdates). */
  push(update: Record<string, unknown>): void
  close(): Promise<void>
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const token = '7000001:fake-token-for-tests'
  const calls: Recorded[] = []
  const blocked = new Set<number>()
  const queue: Array<Record<string, unknown>> = []
  let messageId = 0

  const server = await listen(async (request, response) => {
    const body = await readJson(request)
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '')
    const method = match?.[2] ?? ''
    calls.push({ method, path: request.url ?? '', headers: request.headers, body })
    if (match?.[1] !== token) {
      send(response, 401, { ok: false, error_code: 401, description: 'Unauthorized' })
      return
    }
    const ok = (result: unknown) => send(response, 200, { ok: true, result })
    switch (method) {
      case 'getMe':
        ok({
          id: 7000001,
          is_bot: true,
          first_name: 'kchs',
          username: FAKE_BOT_USERNAME,
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        })
        return
      case 'sendMessage': {
        const chatId = Number(body.chat_id)
        if (blocked.has(chatId)) {
          send(response, 403, {
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked by the user',
          })
          return
        }
        messageId += 1
        ok({
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
          text: body.text,
        })
        return
      }
      case 'sendDocument': {
        const fields = multipartFields(String(body.raw ?? ''))
        const chatId = Number(fields.chat_id ?? body.chat_id)
        if (blocked.has(chatId)) {
          send(response, 403, {
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked by the user',
          })
          return
        }
        messageId += 1
        ok({
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private' },
          document: { file_id: `file-${messageId}`, file_unique_id: `u-${messageId}` },
        })
        return
      }
      case 'deleteWebhook':
        ok(true)
        return
      // Ответ на нажатие кнопки (ADR-0082): подсказка во всплывающем сообщении
      case 'answerCallbackQuery':
        ok(true)
        return
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0)
        const ready = queue.filter((update) => Number(update.update_id) >= offset)
        if (ready.length > 0) {
          ok(ready)
          return
        }
        // Короткий «долгий опрос»: пустой ответ через 100 мс
        await new Promise((resolve) => setTimeout(resolve, 100))
        ok([])
        return
      }
      default:
        send(response, 404, { ok: false, error_code: 404, description: 'Not Found' })
    }
  })

  return {
    url: server.url,
    token,
    calls,
    documents: () =>
      calls
        .filter((call) => call.method === 'sendDocument')
        .map((call) => {
          const raw = String(call.body.raw ?? '')
          const fields = multipartFields(raw)
          return {
            chatId: Number(fields.chat_id),
            // grammy пишет имя файла без кавычек: `filename=<имя>\r\n`
            fileName: /filename=([^\r]*)\r\n/.exec(raw)?.[1] ?? '',
            caption: fields.caption ?? '',
            pdf: raw.includes('%PDF-'),
          }
        }),
    sent: () =>
      calls
        .filter((call) => call.method === 'sendMessage')
        .map((call) => ({
          chatId: Number(call.body.chat_id),
          text: String(call.body.text ?? ''),
          markup: call.body.reply_markup,
        })),
    block: (chatId) => blocked.add(chatId),
    push: (update) => queue.push(update),
    close: server.close,
  }
}

/** Сообщение пользователя боту в виде обновления Bot API. */
export function telegramMessage(
  updateId: number,
  chat: { id: number; type?: 'private' | 'group' },
  text: string,
  from: { username?: string; language_code?: string } = {},
): Record<string, unknown> {
  const command = /^\/\w+/.exec(text)
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat:
        chat.type === 'group'
          ? { id: chat.id, type: 'group', title: 'Группа' }
          : { id: chat.id, type: 'private', first_name: 'Тест' },
      from: {
        id: chat.id,
        is_bot: false,
        first_name: 'Тест',
        ...(from.username ? { username: from.username } : {}),
        language_code: from.language_code ?? 'ru',
      },
      text,
      ...(command
        ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] }
        : {}),
    },
  }
}

/** Нажатие кнопки под сообщением бота (callback_query) в личном чате. */
export function telegramCallback(
  updateId: number,
  chatId: number,
  data: string,
): Record<string, unknown> {
  const from = { id: chatId, is_bot: false, first_name: 'Тест', language_code: 'ru' }
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from,
      chat_instance: `chat-${chatId}`,
      data,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'Тест' },
        from: { id: 7000001, is_bot: true, first_name: 'kchs' },
        text: 'Уведомление',
      },
    },
  }
}

// ─── Провайдеры ИИ ───────────────────────────────────────────────────────────

export interface FakeAi {
  url: string
  calls: Recorded[]
  /** Следующие ответы модели по очереди: объект — JSON-ответ, строка — текст как есть. */
  reply(...answers: Array<Record<string, unknown> | string>): void
  /** Следующий запрос завершится ошибкой HTTP. */
  fail(status: number): void
  close(): Promise<void>
}

/**
 * Поддельный провайдер: Anthropic Messages API (`POST /v1/messages`) и
 * OpenAI-совместимый `POST /v1/chat/completions` — модель «отвечает» заранее
 * заданным JSON.
 */
export async function startFakeAi(): Promise<FakeAi> {
  const calls: Recorded[] = []
  const answers: Array<Record<string, unknown> | string> = []
  const failures: number[] = []

  const server = await listen(async (request, response) => {
    const body = await readJson(request)
    const path = (request.url ?? '').split('?')[0] ?? ''
    calls.push({ method: request.method ?? '', path, headers: request.headers, body })
    const failure = failures.shift()
    if (failure) {
      send(response, failure, {
        type: 'error',
        error: { type: 'api_error', message: 'fake failure' },
      })
      return
    }
    const answer = answers.shift() ?? { answerable: false, reason: 'нет ответа' }
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer)
    if (path.endsWith('/messages')) {
      send(response, 200, {
        id: `msg_${calls.length}`,
        type: 'message',
        role: 'assistant',
        model: String(body.model ?? 'claude-sonnet-5'),
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 150 },
      })
      return
    }
    if (path.endsWith('/chat/completions')) {
      send(response, 200, {
        id: `chatcmpl_${calls.length}`,
        object: 'chat.completion',
        model: String(body.model ?? 'local'),
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
      })
      return
    }
    send(response, 404, { error: 'not found' })
  })

  return {
    url: server.url,
    calls,
    reply: (...next) => answers.push(...next),
    fail: (status) => failures.push(status),
    close: server.close,
  }
}

/**
 * Поддельный движок векторов (ADR-0099): отвечает на `POST /ai/embed`
 * детерминированными векторами — близость определяется общими словами, как у
 * настоящей модели, но без её веса и загрузки.
 */
export interface FakeEmbeddings {
  url: string
  calls: Recorded[]
  /** Следующий вызов вернёт «модель не настроена». */
  disable: () => void
  enable: () => void
  close: () => Promise<void>
}

const EMBED_DIM = 1024

/** Вектор по словам текста: одинаковые слова дают близкие направления. */
function wordVector(text: string): number[] {
  const vector = new Array<number>(EMBED_DIM).fill(0)
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  for (const word of words) {
    let hash = 2166136261
    for (const char of word) {
      hash ^= char.codePointAt(0) ?? 0
      hash = Math.imul(hash, 16777619) >>> 0
    }
    const slot = hash % EMBED_DIM
    vector[slot] = (vector[slot] ?? 0) + 1
  }
  const length = Math.hypot(...vector) || 1
  return vector.map((value) => value / length)
}

export async function startFakeEmbeddings(): Promise<FakeEmbeddings> {
  const calls: Recorded[] = []
  let enabled = true

  const server = await listen(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://fake').pathname
    const body = await readJson(request)
    calls.push({ method: request.method ?? 'GET', path, headers: request.headers, body })
    if (path !== '/ai/embed') {
      send(response, 404, { detail: 'not found' })
      return
    }
    if (!enabled) {
      send(response, 503, { detail: 'Модель векторов не настроена' })
      return
    }
    const texts = (body.texts as string[] | undefined) ?? []
    send(response, 200, {
      model: 'fake-bge-m3',
      dim: EMBED_DIM,
      vectors: texts.map((text) => wordVector(text)),
    })
  })

  return {
    url: server.url,
    calls,
    disable: () => {
      enabled = false
    },
    enable: () => {
      enabled = true
    },
    close: server.close,
  }
}
