import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { keys } from '~/shared/api/queries.js'
import { meFixture, renderWithClient, stubApi, testQueryClient } from '~/test/render.js'
import { RunAsSelect } from './run-as-select.js'

/**
 * «Работает от имени» у правила и формы (ADR-0130): в списке только действующие служебные
 * записи; выбранная и потом заблокированная видна с пометкой; завести новую может только
 * тот, кто ведёт пользователей.
 */
const ACTIVE = '00000000-0000-4000-8000-0000000000a1'
const BLOCKED = '00000000-0000-4000-8000-0000000000a2'
const accounts = {
  items: [
    { id: ACTIVE, name: 'Робот сводок', status: 'active' },
    { id: BLOCKED, name: 'Старый робот', status: 'blocked' },
  ],
}

function renderSelect(value: string | null, capabilities: string[] = [], disabled = false) {
  const me = meFixture({ capabilities: capabilities as never })
  const calls = stubApi({ '/me': me, '/service-accounts': accounts })
  const client = testQueryClient()
  client.setQueryData(keys.me, me)
  const onChange = vi.fn()
  renderWithClient(<RunAsSelect value={value} onChange={onChange} disabled={disabled} />, client)
  return { calls, onChange }
}

describe('RunAsSelect', () => {
  it('в списке — «не выбрана» и действующие; выбор отдаёт идентификатор', async () => {
    const user = userEvent.setup()
    const { onChange } = renderSelect(null)
    await user.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: 'Робот сводок' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Не выбрана' })).toBeVisible()
    expect(screen.queryByRole('option', { name: /Старый робот/ })).toBeNull()
    await user.click(screen.getByRole('option', { name: 'Робот сводок' }))
    expect(onChange).toHaveBeenCalledWith(ACTIVE)
  })

  it('заблокированная выбранная запись видна с пометкой', async () => {
    renderSelect(BLOCKED)
    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveTextContent(
        'Старый робот (заблокирована) — выберите другую',
      ),
    )
  })

  it('завести запись — только с users.manage и не в режиме просмотра', async () => {
    renderSelect(null, ['users.manage'])
    expect(await screen.findByRole('button', { name: 'Завести служебную запись' })).toBeVisible()
  })

  it('без способности или в режиме просмотра — без кнопки и без запроса списка', async () => {
    renderSelect(null)
    expect(screen.queryByRole('button', { name: 'Завести служебную запись' })).toBeNull()
    const { calls } = renderSelect(null, ['users.manage'], true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.map((call) => call.path)).not.toContain('/service-accounts')
    expect(screen.queryByRole('button', { name: 'Завести служебную запись' })).toBeNull()
  })
})
