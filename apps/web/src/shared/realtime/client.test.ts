import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Переподключение realtime (ADR-0215): сообщения за разрыв шлюз не повторяет, поэтому
 * клиент после переподключения перечитывает открытые экраны одной волной; первое
 * подключение и частые разрывы шторма запросов не дают.
 */
type Handler = (...args: unknown[]) => void

class FakeSocket {
  connected = false
  handlers = new Map<string, Handler[]>()
  emitted: Array<{ event: string; payload: unknown }> = []
  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }
  onAny(): this {
    return this
  }
  emit(event: string, payload: unknown): this {
    this.emitted.push({ event, payload })
    return this
  }
  disconnect(): this {
    this.connected = false
    return this
  }
  fire(event: string): void {
    if (event === 'connect') this.connected = true
    if (event === 'disconnect') this.connected = false
    for (const handler of this.handlers.get(event) ?? []) handler()
  }
}

const sockets: FakeSocket[] = []
vi.mock('socket.io-client', () => ({
  io: () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  },
}))

const { connectRealtime, disconnectRealtime, subscribeRooms } = await import('./client.js')

afterEach(() => {
  disconnectRealtime()
  sockets.length = 0
})

function setup() {
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  connectRealtime(client)
  const socket = sockets.at(-1)
  if (!socket) throw new Error('сокет не создан')
  return { client, invalidate, socket }
}

describe('клиент realtime после разрыва', () => {
  it('первое подключение данных не перечитывает', () => {
    const { invalidate, socket } = setup()
    socket.fire('connect')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('переподключение — одна волна перечитывания и комнаты заново', async () => {
    const { invalidate, socket } = setup()
    subscribeRooms(['object:a'])
    socket.fire('connect')
    socket.emitted.length = 0

    socket.fire('disconnect')
    socket.fire('connect')
    await Promise.resolve()

    expect(invalidate).toHaveBeenCalledTimes(1)
    // Без фильтра — все запросы; идущие не отменяются (догрузка страниц)
    expect(invalidate).toHaveBeenCalledWith(undefined, { cancelRefetch: false })
    expect(socket.emitted).toEqual([{ event: 'subscribe', payload: { rooms: ['object:a'] } }])
  })

  it('частые разрывы, пока идёт волна, второй волны не начинают', async () => {
    const { client, invalidate, socket } = setup()
    let release: () => void = () => undefined
    invalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    socket.fire('connect')
    for (let i = 0; i < 3; i += 1) {
      socket.fire('disconnect')
      socket.fire('connect')
    }
    expect(invalidate).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(client.isFetching()).toBe(0))
    // Волна закончилась — следующий разрыв снова перечитывает
    socket.fire('disconnect')
    socket.fire('connect')
    expect(invalidate).toHaveBeenCalledTimes(2)
  })
})
