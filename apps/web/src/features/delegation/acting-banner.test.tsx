import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keys } from '~/shared/api/queries.js'
import { getOnBehalfOf, setOnBehalfOf } from '~/shared/api/session.js'
import {
  delegationFixture,
  meFixture,
  renderWithClient,
  stubApi,
  testQueryClient,
  userRef,
} from '~/test/render.js'
import { ActingBanner } from './acting-banner.js'

/**
 * Баннер «Вы замещаете» (03-access-model.md §Делегирование). Регрессия этапа 8: выбор «от
 * имени» жил вне React, и баннер менялся, только пока оболочка перерисовывалась на каждый
 * ответ `/me`. Здесь `/me` отвечает тем же — структурно равный ответ перерисовки не даёт.
 */
const boss = userRef('00000000-0000-4000-8000-0000000000b1', 'Начальник Штаба')
const other = userRef('00000000-0000-4000-8000-0000000000b2', 'Заместитель Другой')

afterEach(() => setOnBehalfOf(null))

function renderBanner(me = meFixture({ actingFor: [delegationFixture('d1', boss)] })) {
  const calls = stubApi({ '/me': me })
  const client = testQueryClient()
  client.setQueryData(keys.me, me)
  return { calls, ...renderWithClient(<ActingBanner />, client) }
}

describe('ActingBanner', () => {
  it('без замещений баннера нет', () => {
    renderBanner(meFixture())
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('выбор замещаемого включает режим без перечитывания /me; выход — выключает', async () => {
    const user = userEvent.setup()
    const { calls } = renderBanner()
    expect(screen.getByRole('combobox')).toHaveTextContent('Действую от себя')
    expect(screen.queryByRole('button', { name: 'Выйти из режима' })).toBeNull()

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Начальник Штаба' }))

    expect(getOnBehalfOf()).toBe(boss.id)
    expect(screen.getByRole('combobox')).toHaveTextContent('Начальник Штаба')
    const exit = screen.getByRole('button', { name: 'Выйти из режима' })
    // Смена режима перечитывает данные: права и списки зависят от того, от чьего имени запрос
    await waitFor(() => expect(calls.some((call) => call.path === '/me')).toBe(true))

    await user.click(exit)
    expect(getOnBehalfOf()).toBeNull()
    expect(screen.getByRole('combobox')).toHaveTextContent('Действую от себя')
    expect(screen.queryByRole('button', { name: 'Выйти из режима' })).toBeNull()
  })

  it('режим, выбранный раньше во вкладке, виден сразу', () => {
    setOnBehalfOf(boss.id)
    renderBanner()
    expect(screen.getByRole('combobox')).toHaveTextContent('Начальник Штаба')
    expect(screen.getByRole('button', { name: 'Выйти из режима' })).toBeVisible()
  })

  it('замещение закончилось, пока вкладка открыта, — режим сбрасывается', async () => {
    setOnBehalfOf(boss.id)
    renderBanner(meFixture({ actingFor: [delegationFixture('d2', other)] }))
    await waitFor(() => expect(getOnBehalfOf()).toBeNull())
    expect(screen.getByRole('combobox')).toHaveTextContent('Действую от себя')
  })

  it('пока /me не пришёл, выбранный режим не сбрасывается', () => {
    setOnBehalfOf(boss.id)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    )
    renderWithClient(<ActingBanner />)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(getOnBehalfOf()).toBe(boss.id)
  })
})
