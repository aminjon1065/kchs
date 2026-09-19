import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  type Connection,
  Hocuspocus,
  type onAuthenticatePayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
  type WebSocketLike,
} from '@hocuspocus/server'
import crossws from 'crossws/adapters/node'
import type { Redis } from 'ioredis'
import * as Y from 'yjs'
import { config } from '~/shared/config/index.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { authorize, loadObject } from '../access/authorize.js'
import { buildUserCtx } from '../context-builder.js'
import { COLLAB_CHANNEL, collabType } from './registry.js'
import { CollabStore } from './store.js'

/**
 * Сервер совместного редактирования (ADR-0070, 16-api-and-events.md §3):
 * Hocuspocus в процессе api на том же HTTP-сервере, WebSocket на `/collab`.
 * Имя документа — идентификатор объекта. Вход — cookie сессии и CSRF-токен в
 * поле `token` протокола; права — `authorize()`: `view` открывает документ
 * только для чтения, `edit` — для правки. Состояние — в `yjs.documents`,
 * снимок тела в JSON — у модуля типа (реестр `registerCollabType`).
 */

const COLLAB_PATH = '/collab'

/** Права подключения перепроверяются не реже раза в минуту: сессия, ACL, корзина. */
const RECHECK_MS = 60_000
/** Одно сообщение протокола — не больше 16 МБ (первая синхронизация большого документа). */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
/** Код закрытия документа при потере прав: клиент переподключается и узнаёт новые. */
const ACCESS_CHANGED = { code: 4403, reason: 'access_changed' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Слияние из базы в открытый документ: сохранять его повторно не нужно. */
const MERGE_ORIGIN = { source: 'local', skipStoreHooks: true } as const

/** Разрешение сессии приходит извне: ядро не знает о модуле идентификации. */
export interface CollabDeps {
  resolveSession: (token: string) => Promise<{
    sessionId: string
    userId: string
    csrfToken: string
    onBehalfOf: string | null
    mfaEnrolled: boolean
  } | null>
}

/** Контекст подключения к документу: кто, к чему, с каким правом и когда проверено. */
interface CollabContext {
  ip?: string | null
  user?: UserCtx
  objectId?: string
  type?: string
  canEdit?: boolean
  checkedAt?: number
}

type Refusal = 'unauthorized' | 'setup_required' | 'not_found' | 'access_changed'

/**
 * Отказ в подключении: причина уходит клиенту (`onAuthenticationFailed`).
 * Сообщение пустое — Hocuspocus печатает в консоль только ошибки с текстом.
 */
class CollabRefused extends Error {
  readonly code = ACCESS_CHANGED.code
  constructor(readonly reason: Refusal) {
    super('')
  }
}

interface Access {
  type: string
  canEdit: boolean
}

let instance: Hocuspocus<CollabContext> | null = null
let deps: CollabDeps | null = null
let sockets: ReturnType<typeof crossws> | null = null
let attached: { server: HttpServer; listener: (...args: unknown[]) => void } | null = null
let subscriber: Redis | null = null

const log = () => logger().child({ module: 'collab' })

/** Экземпляр Hocuspocus процесса: создаётся при первом обращении (сокеты или правка сервером). */
function collab(): Hocuspocus<CollabContext> {
  if (instance) return instance
  instance = new Hocuspocus<CollabContext>({
    name: 'kchs-collab',
    quiet: true,
    // Сохранение — через 2 с после последней правки, но не реже раза в 10 с
    debounce: 2_000,
    maxDebounce: 10_000,
    onAuthenticate: authenticate,
    onLoadDocument: loadDocument,
    onStoreDocument: storeDocument,
    beforeHandleMessage: async ({ connection }) => {
      const context = connection.context as CollabContext
      if (Date.now() - (context.checkedAt ?? 0) < RECHECK_MS) return
      if (!(await recheck(connection))) throw new CollabRefused('access_changed')
    },
  })
  return instance
}

// ─── Вход и права ────────────────────────────────────────────────────────────

async function authenticate(
  payload: onAuthenticatePayload<CollabContext>,
): Promise<Partial<CollabContext>> {
  const objectId = payload.documentName
  if (!UUID_RE.test(objectId)) throw new CollabRefused('not_found')
  const user = await sessionUser(payload.requestHeaders, payload.context, payload.token)
  const access = await accessOf(user, objectId)
  if (!access) throw new CollabRefused('not_found')
  payload.connectionConfig.readOnly = !access.canEdit
  return {
    user,
    objectId,
    type: access.type,
    canEdit: access.canEdit,
    checkedAt: Date.now(),
  }
}

/**
 * Пользователь подключения: сессия из cookie запроса апгрейда. При входе в
 * документ сверяется и CSRF-токен — чужая страница, открывшая сокет с cookie
 * пользователя, его не знает (атака CSWSH). Пока не сменён временный пароль или
 * не подключён обязательный второй фактор — только профиль, как у realtime.
 */
async function sessionUser(
  headers: Headers,
  context: CollabContext,
  csrfToken: string | null,
): Promise<UserCtx> {
  if (!deps) throw new CollabRefused('unauthorized')
  const token = cookieValue(headers.get('cookie') ?? '', config().SESSION_COOKIE_NAME)
  if (!token) throw new CollabRefused('unauthorized')
  const session = await deps.resolveSession(token)
  if (!session) throw new CollabRefused('unauthorized')
  if (csrfToken !== null && csrfToken !== session.csrfToken) {
    throw new CollabRefused('unauthorized')
  }
  let user: UserCtx
  try {
    user = await buildUserCtx(session, {
      id: `collab_${Math.random().toString(36).slice(2, 12)}`,
      ip: context.ip ?? null,
      headers: { 'user-agent': headers.get('user-agent') ?? undefined },
    } as never)
  } catch {
    throw new CollabRefused('unauthorized')
  }
  if (user.mustChangePassword || user.mfaEnrollmentRequired) {
    throw new CollabRefused('setup_required')
  }
  return user
}

/** Документ открывается для чтения с `view` и для правки с `edit`; архив — только чтение. */
async function accessOf(user: UserCtx, objectId: string): Promise<Access | null> {
  const object = await loadObject(objectId)
  if (!object || !collabType(object.type)) return null
  const view = await authorize(user, 'view', object, { soft: true })
  if (!view.allowed) return null
  const edit = await authorize(user, 'edit', object, { soft: true })
  return { type: object.type, canEdit: edit.allowed }
}

/**
 * Права подключения ещё прежние? Потеря доступа или смена права — документ
 * закрывается для этого подключения: клиент переподключится и получит
 * отказ или новый режим.
 */
async function recheck(connection: Connection): Promise<boolean> {
  const context = connection.context as CollabContext
  context.checkedAt = Date.now()
  let access: Access | null = null
  if (context.objectId) {
    try {
      const user = await sessionUser(connection.request.headers, context, null)
      access = await accessOf(user, context.objectId)
      if (access) context.user = user
    } catch {
      access = null
    }
  }
  if (access && access.canEdit === context.canEdit) return true
  connection.close(ACCESS_CHANGED)
  return false
}

/** Права изменились (ACL, корзина, перенос): подключения к объекту перепроверяются сразу. */
async function recheckDocument(objectId: string): Promise<void> {
  const document = instance?.documents.get(objectId)
  if (!document) return
  for (const connection of document.getConnections()) await recheck(connection)
}

// ─── Загрузка и сохранение ───────────────────────────────────────────────────

async function definitionOf(objectId: string, context: CollabContext | undefined) {
  const type = context?.type ?? (await loadObject(objectId))?.type
  return type ? collabType(type) : undefined
}

async function loadDocument({
  documentName,
  document,
  context,
}: onLoadDocumentPayload<CollabContext>): Promise<void> {
  const stored = await CollabStore.load(documentName)
  const state =
    stored ??
    (await (await definitionOf(documentName, context))?.initialState?.(documentName, db()))
  if (state) Y.applyUpdate(document, state)
}

async function storeDocument({
  documentName,
  document,
  lastContext,
}: onStoreDocumentPayload<CollabContext>): Promise<void> {
  const context = lastContext as CollabContext | undefined
  // Объект удалён окончательно — хранить нечего
  const object = await loadObject(documentName)
  if (!object) return
  const definition = collabType(object.type)
  const actor: Ctx = context?.user ?? systemCtx('collab.store')
  try {
    await db().transaction(async (tx) => {
      await CollabStore.save(tx, documentName, document, MERGE_ORIGIN)
      await definition?.snapshot(tx, actor, documentName, document)
    })
  } catch (error) {
    // Правки важнее снимка: состояние Yjs сохраняется и без него, снимок
    // догонит при следующем сохранении
    log().error({ err: error, objectId: documentName }, 'снимок документа не записан')
    await db().transaction((tx) => CollabStore.save(tx, documentName, document, MERGE_ORIGIN))
  }
}

// ─── Правка сервером ─────────────────────────────────────────────────────────

/**
 * Правка документа сервером (ячейки из «Исследования», ответы ИИ): прямое
 * подключение к документу процесса — изменения сразу у всех, кто его открыл,
 * и в базе к возврату из функции. Права проверяет вызывающий.
 */
export const CollabService = {
  async change(
    ctx: UserCtx,
    object: { id: string; type: string },
    edit: (doc: Y.Doc) => void,
  ): Promise<void> {
    const connection = await collab().openDirectConnection(object.id, {
      user: ctx,
      objectId: object.id,
      type: object.type,
      canEdit: true,
      ip: ctx.ip,
    })
    try {
      await connection.transact((doc) => edit(doc))
    } finally {
      await connection.disconnect()
    }
  },
}

// ─── Сокеты ──────────────────────────────────────────────────────────────────

function isCollabPath(url: string | undefined): boolean {
  if (!url) return false
  return (
    url === COLLAB_PATH || url.startsWith(`${COLLAB_PATH}/`) || url.startsWith(`${COLLAB_PATH}?`)
  )
}

/**
 * Подключение к HTTP-серверу api: апгрейды на `/collab` обслуживает crossws
 * (как `Server` Hocuspocus), остальные остаются realtime-шлюзу. Рукопожатие
 * завершается сразу — права проверяются уже в протоколе, иначе engine.io
 * закрыл бы «чужой» апгрейд через секунду.
 */
export function startCollab(server: HttpServer, collabDeps: CollabDeps): void {
  deps = collabDeps
  const hocuspocus = collab()
  const clients = new Map<string, ReturnType<typeof hocuspocus.handleConnection>>()

  sockets = crossws({
    serverOptions: { maxPayload: MAX_MESSAGE_BYTES },
    hooks: {
      open(peer) {
        clients.set(
          peer.id,
          hocuspocus.handleConnection(
            peer.websocket as unknown as WebSocketLike,
            peer.request as Request,
            { ip: peer.remoteAddress ?? null },
          ),
        )
      },
      message(peer, message) {
        clients.get(peer.id)?.handleMessage(message.uint8Array())
      },
      close(peer, details) {
        clients
          .get(peer.id)
          ?.handleClose({ code: details.code ?? 1000, reason: details.reason ?? '' })
        clients.delete(peer.id)
      },
      error(peer, error) {
        log().warn({ err: error, peer: peer.id }, 'ошибка сокета совместного редактирования')
      },
    },
  })

  const listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isCollabPath(request.url)) return
    void sockets?.handleUpgrade(request, socket, head)
  }
  server.on('upgrade', listener)
  attached = { server, listener: listener as (...args: unknown[]) => void }

  // Отзыв прав, корзина, перенос — из подписчика событий (worker) через Redis
  subscriber = createRedisConnection('collab-sub')
  void subscriber.subscribe(COLLAB_CHANNEL)
  subscriber.on('message', (_channel, message) => {
    try {
      const { objectId } = JSON.parse(message) as { objectId?: string }
      if (objectId) {
        void recheckDocument(objectId).catch((error) =>
          log().warn({ err: error, objectId }, 'права подключений не перепроверены'),
        )
      }
    } catch {
      // некорректное сообщение
    }
  })

  log().info({ path: COLLAB_PATH }, 'сервер совместного редактирования запущен')
}

/** Остановка: незаписанные правки — в базу, затем закрытие сокетов. */
export async function stopCollab(timeoutMs = 5_000): Promise<void> {
  if (attached) attached.server.off('upgrade', attached.listener)
  attached = null
  await subscriber?.quit().catch(() => undefined)
  subscriber = null
  const hocuspocus = instance
  if (hocuspocus) {
    hocuspocus.closeConnections()
    hocuspocus.flushPendingStores()
    const deadline = Date.now() + timeoutMs
    while (hocuspocus.getDocumentsCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await sockets?.close?.()
  sockets = null
  instance = null
  deps = null
}

/** Открытые документы и подключения процесса (метрики, 15-admin-operations.md §4). */
export function collabStats(): { documents: number; connections: number } {
  return {
    documents: instance?.getDocumentsCount() ?? 0,
    connections: instance?.getConnectionsCount() ?? 0,
  }
}

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0 || part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return null
    }
  }
  return null
}
