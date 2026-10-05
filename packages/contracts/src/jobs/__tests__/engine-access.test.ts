import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { QUEUES, queuesOf } from '../job.js'

/**
 * Пользователь Redis движка (ADR-0176) видит только ключи очередей, которые
 * исполняет движок. Список очередей в ACL написан руками в двух местах — в
 * compose и в чарте; здесь он сверяется с `QUEUE_RUNTIME`, а копии — между собой.
 */
const repo = (path: string) =>
  readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8')

const compose = repo('infra/compose/redis/start.sh')
const chart = repo('infra/helm/kchs/files/redis-start.sh')

describe('доступ движка к Redis', () => {
  it('ключи всех очередей движка и только их', () => {
    for (const queue of QUEUES) {
      const pattern = `'~bull:${queue}:*'`
      expect(compose.includes(pattern), queue).toBe(queuesOf('engine').includes(queue))
    }
  })

  it('чарт запускает Redis тем же скриптом, что и compose', () => {
    expect(chart).toBe(compose)
  })
})
