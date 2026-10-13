import type { InboxItem } from '@kchs/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { InboxScreen } from './inbox-screen.js'

/**
 * Входящие отдаются страницами. Регрессия, найденная сквозным сценарием поручений: событие
 * realtime `inbox.changed` перечитывало список, пока догружалась следующая страница, —
 * догрузка отменялась, и нажатие «Показать ещё» терялось без следа.
 */
const USER = '00000000-0000-4000-8000-0000000000a1'

function item(n: number): InboxItem {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    userId: USER,
    kind: 'acknowledge',
    title: `Ознакомиться с приказом ${n}`,
    body: null,
    object: null,
    actor: null,
    onBehalfOf: null,
    processStepId: null,
    dueAt: null,
    priority: 'normal',
    state: 'open',
    openedAt: '2026-10-13T08:00:00.000Z',
    resolvedAt: null,
    snoozedUntil: null,
    payload: {},
    actions: [],
  }
}

describe('InboxScreen', () => {
  it('«Показать ещё» догружает страницу, даже если её отменило перечитывание списка', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let nextPageRequests = 0
    stubApi({
      '/inbox/counts': {
        total: 4,
        overdue: 0,
        dueToday: 0,
        delegated: 0,
        byKind: { acknowledge: 4 },
      },
      '/inbox': async ({ url }: { url: URL }) => {
        if (!url.searchParams.get('cursor')) return { items: [item(1), item(2)], nextCursor: 'c1' }
        nextPageRequests += 1
        // Первая догрузка «в пути», пока список перечитывается
        if (nextPageRequests === 1) await held
        return { items: [item(3), item(4)], nextCursor: null }
      },
    })
    const user = userEvent.setup()
    const { client } = renderWithClient(<InboxScreen />)
    const list = await screen.findByRole('list', { name: 'Входящие' })
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: 'Показать ещё' }))
    await waitFor(() => expect(nextPageRequests).toBe(1))
    // Как `inbox.changed` из realtime: перечитать все загруженные страницы
    void client.invalidateQueries({ queryKey: ['inbox'] })
    release()

    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(4))
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull()
  })
})
