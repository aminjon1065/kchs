import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { keys } from '~/shared/api/queries.js'
import { meFixture, renderWithClient, stubApi, testQueryClient } from '~/test/render.js'
import { ApiTokensCard } from './api-tokens-card.js'

/**
 * «Мои токены API» (ADR-0097): выпуск — только со способностью `api_tokens.create`, с
 * названием и хотя бы одной областью; значение показывается один раз; отзыв — с
 * подтверждением и только у действующего токена.
 */
const token = (id: string, status: string) => ({
  id,
  name: `Интеграция ${id}`,
  prefix: `kchs_${id}`,
  scopes: ['read:datasets'],
  status,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: '2026-10-13T08:00:00.000Z',
})

function renderCard(capabilities: string[], items: unknown[] = []) {
  const me = meFixture({ capabilities: capabilities as never })
  const calls = stubApi({
    '/me': me,
    '/me/api-tokens': { items },
    'POST /me/api-tokens': { ...token('new', 'active'), secret: 'kchs_new_SECRET' },
    'DELETE /me/api-tokens/t1': { ok: true },
  })
  const client = testQueryClient()
  client.setQueryData(keys.me, me)
  renderWithClient(<ApiTokensCard />, client)
  return calls
}

describe('ApiTokensCard', () => {
  it('без способности — пояснение вместо кнопки выпуска', async () => {
    renderCard([])
    expect(await screen.findByText('Токенов пока нет')).toBeVisible()
    expect(screen.getByText(/Выпуск токенов разрешает администратор/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Выпустить токен' })).toBeNull()
  })

  it('выпуск: нужны название и область; значение показывается один раз', async () => {
    const user = userEvent.setup()
    const calls = renderCard(['api_tokens.create'])
    await user.click(await screen.findByRole('button', { name: 'Выпустить токен' }))
    const dialog = await screen.findByRole('dialog')
    const issue = within(dialog).getByRole('button', { name: 'Выпустить' })
    expect(issue).toBeDisabled()

    await user.type(within(dialog).getByRole('textbox', { name: /Название/ }), 'Сайт Комитета')
    expect(issue).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'read:datasets' }))
    expect(issue).toBeEnabled()
    await user.click(issue)

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/me/api-tokens',
        body: { name: 'Сайт Комитета', scopes: ['read:datasets'], expiresAt: null },
      }),
    )
    const issued = await screen.findByRole('dialog', { name: 'Токен выпущен' })
    expect(within(issued).getByText('kchs_new_SECRET')).toBeVisible()
  })

  it('отзыв — у действующего токена и после подтверждения', async () => {
    const user = userEvent.setup()
    const calls = renderCard(['api_tokens.create'], [token('t1', 'active'), token('t2', 'revoked')])
    expect(await screen.findByText('Интеграция t2')).toBeVisible()
    const revokeButtons = screen.getAllByRole('button', { name: 'Отозвать' })
    expect(revokeButtons).toHaveLength(1)

    await user.click(revokeButtons[0] as HTMLElement)
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Отозвать токен «Интеграция t1»?')).toBeVisible()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await user.click(within(confirm).getByRole('button', { name: 'Отозвать' }))
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/me/api-tokens/t1' }),
      ),
    )
  })
})
