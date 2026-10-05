import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { isRedisUnavailable, toProblem } from './problem.js'

const request = { url: '/api/v1/objects', headers: { 'accept-language': 'ru' } } as FastifyRequest

describe('toProblem', () => {
  it('сброс нагрузки (under-pressure) — 503 «временно недоступен», не внутренняя ошибка', () => {
    const overload = Object.assign(new Error('Сервис перегружен'), {
      statusCode: 503,
      code: 'FST_UNDER_PRESSURE',
    })
    expect(toProblem(overload, request)).toMatchObject({
      status: 503,
      code: 'service_unavailable',
      title: 'Сервис временно недоступен',
      detail: 'Сервис перегружен',
    })
  })

  it('недоступный Redis — 503 с повтором, а не внутренняя ошибка (ADR-0175)', () => {
    const exhausted = new Error('Reached the max retries per request limit (which is 2).')
    Object.defineProperty(exhausted, 'name', { value: 'MaxRetriesPerRequestError' })
    for (const error of [
      exhausted,
      new Error('Command timed out'),
      new Error('Connection is closed.'),
      new Error("Stream isn't writeable and enableOfflineQueue options is false"),
    ]) {
      expect(isRedisUnavailable(error)).toBe(true)
      expect(toProblem(error, request)).toMatchObject({
        status: 503,
        code: 'service_unavailable',
        retryAfter: 5,
      })
    }
    // Ответ самого Redis на команду — обычная внутренняя ошибка
    const reply = new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    expect(isRedisUnavailable(reply)).toBe(false)
    expect(toProblem(reply, request)).toMatchObject({ status: 500, code: 'internal_error' })
  })

  it('ошибки Fastify до 500 — их статус и код', () => {
    const tooMany = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 })
    expect(toProblem(tooMany, request)).toMatchObject({ status: 429, code: 'rate_limited' })
    const tooLarge = Object.assign(new Error('Body too large'), { statusCode: 413 })
    expect(toProblem(tooLarge, request)).toMatchObject({ status: 413, code: 'payload_too_large' })
  })
})
