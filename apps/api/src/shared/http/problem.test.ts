import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { toProblem } from './problem.js'

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

  it('ошибки Fastify до 500 — их статус и код', () => {
    const tooMany = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 })
    expect(toProblem(tooMany, request)).toMatchObject({ status: 429, code: 'rate_limited' })
    const tooLarge = Object.assign(new Error('Body too large'), { statusCode: 413 })
    expect(toProblem(tooLarge, request)).toMatchObject({ status: 413, code: 'payload_too_large' })
  })
})
