import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '~/shared/api/errors.js'
import { keys } from '~/shared/api/queries.js'
import {
  discardOfflineEntry,
  enqueueFormSubmit,
  flushOfflineQueue,
  setOfflineSender,
  startOfflineQueue,
} from '~/shared/offline/queue.js'
import {
  delegationFixture,
  ME_ID,
  meFixture,
  renderWithClient,
  stubApi,
  testQueryClient,
  userRef,
} from '~/test/render.js'
import { StatusBar } from './status-bar.js'

/**
 * Строка состояния: связь, задания, «Вы замещаете» и офлайн-очередь (ADR-0204) — в строке
 * только свои отправки, которые ждут сети; отказ по существу и чужие не считаются.
 */
let stop: () => void = () => undefined

afterEach(async () => {
  stop()
  setOfflineSender(null)
  for (const id of ['k1', 'k2', 'k3', 'k4']) await discardOfflineEntry(id)
})

function renderBar(me = meFixture()) {
  stubApi({ '/me': me, '/jobs': { items: [] } })
  const client = testQueryClient()
  client.setQueryData(keys.me, me)
  return renderWithClient(<StatusBar onShowShortcuts={() => undefined} />, client)
}

const body = (clientKey: string) => ({ values: {}, clientKey })

describe('StatusBar', () => {
  it('без связи и очереди — только состояние связи и клавиши', () => {
    renderBar()
    expect(screen.getByText('Нет соединения')).toBeVisible()
    expect(screen.queryByText(/ждут? сети/)).toBeNull()
    expect(screen.getByRole('button', { name: /Горячие клавиши/ })).toBeVisible()
  })

  it('свои отправки без сети — в строке; отказ по существу и чужие — нет', async () => {
    setOfflineSender(async (entry) => {
      if (entry.id === 'k3') {
        throw new ApiError({
          type: 'about:blank',
          title: 'x',
          status: 409,
          code: 'conflict',
          detail: 'Сводка уже сдана',
        })
      }
      throw new TypeError('Failed to fetch')
    })
    stop = startOfflineQueue(ME_ID)
    renderBar()
    await act(async () => {
      await enqueueFormSubmit({ userId: ME_ID, submissionId: 's3', formId: 'f', body: body('k3') })
      await enqueueFormSubmit({ userId: ME_ID, submissionId: 's1', formId: 'f', body: body('k1') })
      await enqueueFormSubmit({ userId: ME_ID, submissionId: 's2', formId: 'f', body: body('k2') })
      await enqueueFormSubmit({
        userId: 'someone-else',
        submissionId: 's4',
        formId: 'f',
        body: body('k4'),
      })
      await flushOfflineQueue()
    })
    // k3 отклонён сервером — ждёт человека, а не сети; k4 — чужая
    expect(screen.getByText('2 отправки ждут сети')).toBeVisible()

    setOfflineSender(async (entry) => ({ id: entry.submissionId }) as never)
    await act(async () => {
      await flushOfflineQueue()
    })
    expect(screen.queryByText(/ждут? сети/)).toBeNull()
  })

  it('замещение — бейдж с именем замещаемого', () => {
    const boss = userRef('00000000-0000-4000-8000-0000000000b1', 'Начальник Штаба')
    renderBar(meFixture({ actingFor: [delegationFixture('d1', boss)] }))
    expect(screen.getByText('Вы замещаете: Начальник Штаба')).toBeVisible()
  })

  it('идущие задания — счётчик с прогрессом первого', async () => {
    const job = (id: string, status: string) => ({
      id,
      name: `Импорт ${id}`,
      status,
      progress: 40,
    })
    stubApi({
      '/jobs': { items: [job('a', 'running'), job('b', 'queued'), job('c', 'done')] },
    })
    renderWithClient(<StatusBar onShowShortcuts={() => undefined} />)
    expect(await screen.findByText('2 задания')).toBeVisible()
  })
})
