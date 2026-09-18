import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Поддельные внешние сервисы для интеграционных тестов: настоящий Telegram
 * не вызывается (ADR-0061). Адрес подставляется через TELEGRAM_API_URL.
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

// ─── Telegram Bot API ────────────────────────────────────────────────────────

export const FAKE_BOT_USERNAME = 'kchs_test_bot'

export interface FakeTelegram {
  url: string
  token: string
  calls: Recorded[]
  /** Отправленные ботом сообщения: чат и текст. */
  sent(): Array<{ chatId: number; text: string; markup: unknown }>
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
      case 'deleteWebhook':
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
