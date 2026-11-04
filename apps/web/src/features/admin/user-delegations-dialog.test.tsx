import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi, userRef } from '~/test/render.js'
import { UserDelegationsDialog } from './user-delegations-dialog.js'

/**
 * Замещения сотрудника в консоли (ADR-0229): действующие и запланированные видны,
 * запланированное отменяется, заместителя назначают за сотрудника.
 */
const USER = { id: '00000000-0000-4000-8000-0000000000a1', displayName: 'Начальник Отсутствующий' }
const DEPUTY = userRef('00000000-0000-4000-8000-0000000000a2', 'Заместитель Временный')
const FROM = userRef(USER.id, USER.displayName)

const delegation = (id: string, upcoming: boolean) => ({
  id,
  fromUser: FROM,
  toUser: DEPUTY,
  scope: 'documents',
  startsAt: '2026-11-10T00:00:00.000Z',
  endsAt: '2026-11-20T23:59:59.000Z',
  note: null,
  upcoming,
})

const ACTIVE = '00000000-0000-4000-8000-0000000000d1'
const PLANNED = '00000000-0000-4000-8000-0000000000d2'

describe('UserDelegationsDialog', () => {
  it('действующее — «Завершить», запланированное — «Запланировано» и «Отменить»', async () => {
    const calls = stubApi({
      [`/users/${USER.id}/delegations`]: {
        items: [delegation(ACTIVE, false), delegation(PLANNED, true)],
      },
      [`DELETE /me/delegations/${PLANNED}`]: { ok: true },
    })
    const user = userEvent.setup()
    renderWithClient(<UserDelegationsDialog user={USER} onClose={() => undefined} />)

    expect(await screen.findByText('Запланировано')).toBeVisible()
    expect(screen.getByText('Действует')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Завершить' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true))
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe(`/me/delegations/${PLANNED}`)
  })

  it('заместитель назначается за сотрудника — запрос в консоль, а не в «мои»', async () => {
    const calls = stubApi({
      [`/users/${USER.id}/delegations`]: { items: [] },
      '/principals/search': {
        items: [{ type: 'user', id: DEPUTY.id, title: DEPUTY.displayName, avatarUrl: null }],
      },
      [`POST /users/${USER.id}/delegations`]: { id: '00000000-0000-4000-8000-0000000000d3' },
    })
    const user = userEvent.setup()
    renderWithClient(<UserDelegationsDialog user={USER} onClose={() => undefined} />)

    expect(await screen.findByText('Замещений нет')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Назначить заместителя' }))
    await user.type(await screen.findByRole('searchbox'), 'Замес')
    await user.click(await screen.findByRole('button', { name: DEPUTY.displayName }))
    await user.click(screen.getByRole('button', { name: 'Назначить' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true))
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.path).toBe(`/users/${USER.id}/delegations`)
    expect(post?.body).toMatchObject({ toUserId: DEPUTY.id, scope: 'all' })
    expect(calls.some((call) => call.path === '/me/delegations')).toBe(false)
  })
})
