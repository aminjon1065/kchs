import type { DocumentRecord } from '@kchs/contracts'
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { keys } from '~/shared/api/queries.js'
import {
  delegationFixture,
  ME_ID,
  meFixture,
  renderWithClient,
  stubApi,
  testQueryClient,
  userRef,
} from '~/test/render.js'
import { DocumentProvider } from './document-context.js'
import { DocumentStepActions } from './step-actions.js'

/**
 * Действия шага в карточке (ADR-0083): кнопки — по правам, которые посчитал сервер
 * (`document.can`); маршрут запрашивается, только когда шаг ждёт смотрящего или того, кого
 * он замещает.
 */
const boss = userRef('00000000-0000-4000-8000-0000000000b1', 'Начальник Штаба')
const none = { register: false, cancel: false, startRoute: false }

function documentFixture(
  can: Partial<typeof none>,
  pending: string[] | null = null,
): DocumentRecord {
  return {
    id: '00000000-0000-4000-8000-00000000d0c1',
    can: { ...none, ...can },
    route: pending
      ? { instanceId: 'p1', steps: [{ pending: pending.map((id) => userRef(id, id)) }] }
      : null,
  } as unknown as DocumentRecord
}

function renderActions(document: DocumentRecord, me = meFixture()) {
  const calls = stubApi({ '/me': me, '/processes/p1': { myActions: [] } })
  const client = testQueryClient()
  client.setQueryData(keys.me, me)
  renderWithClient(
    <DocumentProvider document={document} tabId={null}>
      <DocumentStepActions />
    </DocumentProvider>,
    client,
  )
  return calls
}

describe('DocumentStepActions', () => {
  it('без прав и без шага для меня — блока нет', () => {
    renderActions(documentFixture({}))
    expect(screen.queryByRole('region', { name: 'Действия' })).toBeNull()
  })

  it('кнопки — ровно по правам сервера; главная — первая доступная', () => {
    renderActions(documentFixture({ register: true, cancel: true }))
    expect(screen.getByRole('button', { name: 'Зарегистрировать' })).toHaveClass('bg-accent')
    expect(screen.getByRole('button', { name: 'Аннулировать' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Отправить на согласование' })).toBeNull()
  })

  it('черновик: отправка на согласование — главная, регистрация — вторичная', () => {
    renderActions(documentFixture({ startRoute: true, register: true }))
    // Главная кнопка — акцентная (вариант `primary` дизайн-системы)
    expect(screen.getByRole('button', { name: 'Отправить на согласование' })).toHaveClass(
      'bg-accent',
    )
    expect(screen.getByRole('button', { name: 'Зарегистрировать' })).not.toHaveClass('bg-accent')
  })

  it('шаг ждёт замещаемого — маршрут запрашивается; чужой шаг — нет', async () => {
    const acting = meFixture({ actingFor: [delegationFixture('d1', boss)] })
    const calls = renderActions(documentFixture({}, [boss.id]), acting)
    await waitFor(() => expect(calls.map((call) => call.path)).toContain('/processes/p1'))

    const other = renderActions(documentFixture({}, ['00000000-0000-4000-8000-0000000000c9']))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(other.map((call) => call.path)).not.toContain('/processes/p1')
  })

  it('шаг ждёт меня самого — маршрут запрашивается', async () => {
    const calls = renderActions(documentFixture({}, [ME_ID]))
    await waitFor(() => expect(calls.map((call) => call.path)).toContain('/processes/p1'))
  })
})
