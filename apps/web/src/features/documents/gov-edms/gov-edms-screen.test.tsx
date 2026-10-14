import type { GovEdmsIntakeRecord } from '@kchs/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi, userRef } from '~/test/render.js'
import { GovEdmsScreen } from './gov-edms-screen.js'

/**
 * Очередь «Из госЭДО» (ADR-0219): строка — статус документа, реквизиты из текста,
 * состояние разбора и предупреждение о повторе; «Все» перечитывает очередь целиком.
 */
const NOW = '2026-10-14T08:00:00.000Z'

function intake(overrides: Partial<GovEdmsIntakeRecord> = {}): GovEdmsIntakeRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    document: {
      id: '00000000-0000-4000-8000-0000000000d1',
      title: 'О готовности районов',
      status: 'draft',
      regNumber: null,
      externalNumber: '31/77',
      externalDate: '2026-10-10',
      correspondent: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Министерство финансов' },
    },
    fileName: 'письмо.pdf',
    sha256: 'a'.repeat(64),
    prefillStatus: 'done',
    prefill: null,
    duplicateOf: null,
    createdBy: userRef('00000000-0000-4000-8000-000000000001', 'Делопроизводитель'),
    createdAt: NOW,
    ...overrides,
  } as GovEdmsIntakeRecord
}

describe('GovEdmsScreen', () => {
  it('строка очереди: статус, реквизиты, разбор и повтор по отправителю и номеру', async () => {
    stubApi({
      '/documents/gov-edms/intake': {
        items: [
          intake({
            duplicateOf: {
              id: '00000000-0000-4000-8000-0000000000d0',
              title: 'О готовности',
              regNumber: '02-14/88',
              status: 'registered',
            },
          }),
        ],
        nextCursor: null,
      },
    })
    renderWithClient(<GovEdmsScreen />)
    const list = await screen.findByRole('list', { name: 'Из госЭДО' })
    expect(list).toHaveTextContent('О готовности районов')
    expect(list).toHaveTextContent('Черновик')
    expect(list).toHaveTextContent('Министерство финансов · № 31/77 от 10.10.2026')
    expect(list).toHaveTextContent('Реквизиты из текста · письмо.pdf')
    expect(list).toHaveTextContent('Тот же отправитель и номер уже есть: 02-14/88')
  })

  it('пусто — подсказка и загрузка; «Все» запрашивает всю историю', async () => {
    const calls = stubApi({ '/documents/gov-edms/intake': { items: [], nextCursor: null } })
    const user = userEvent.setup()
    renderWithClient(<GovEdmsScreen />)
    expect(await screen.findByText('Документов из госЭДО нет')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Загрузить из госЭДО' })).toHaveLength(2)

    await user.click(screen.getByRole('radio', { name: 'Все' }))
    await waitFor(() =>
      expect(
        calls.some((call) => call.path === '/documents/gov-edms/intake' && call.method === 'GET'),
      ).toBe(true),
    )
  })
})
