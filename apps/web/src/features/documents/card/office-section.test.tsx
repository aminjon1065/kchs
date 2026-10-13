import type { DocumentRecord } from '@kchs/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { DocumentProvider } from './document-context.js'
import { DocumentOfficeSection } from './office-section.js'

/**
 * Письма исходящего на «Карточке» (ADR-0149): «Повторить» — только у не ушедших и
 * вернувшихся писем и только с правом отправки.
 */
const DOC = '00000000-0000-4000-8000-00000000d0c1'

function documentFixture(canDispatch: boolean, direction = 'outgoing'): DocumentRecord {
  return {
    id: DOC,
    type: { direction },
    can: { dispatch: canDispatch },
    dispatchCount: 0,
    case: null,
    registrationCase: null,
    filesDestroyedAt: null,
  } as unknown as DocumentRecord
}

const email = (id: string, status: string, error: string | null = null) => ({
  id,
  to: `${id}@example.org`,
  status,
  error,
  createdAt: '2026-10-13T08:00:00.000Z',
  sentAt: null,
  createdBy: { id: 'u1', displayName: 'Канцелярия', avatarUrl: null },
})

function renderSection(document: DocumentRecord) {
  return renderWithClient(
    <DocumentProvider document={document} tabId={null}>
      <DocumentOfficeSection />
    </DocumentProvider>,
  )
}

describe('DocumentOfficeSection — письма', () => {
  it('«Повторить» у не ушедшего и вернувшегося; повтор ставит письмо в очередь', async () => {
    const calls = stubApi({
      [`/documents/${DOC}/emails`]: {
        items: [
          email('sent', 'sent'),
          email('failed', 'failed', 'Почтовый сервер не ответил'),
          email('bounced', 'bounced'),
          email('queued', 'queued'),
        ],
      },
      [`POST /documents/${DOC}/emails/failed/retry`]: { ok: true },
    })
    renderSection(documentFixture(true))
    const list = await screen.findByRole('region', { name: 'Письма' })
    expect(within(list).getAllByRole('button', { name: 'Повторить' })).toHaveLength(2)
    expect(within(list).getByText('Почтовый сервер не ответил')).toBeVisible()

    const failed = within(list).getByText('failed@example.org').closest('li') as HTMLElement
    await userEvent.click(within(failed).getByRole('button', { name: 'Повторить' }))
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: `/documents/${DOC}/emails/failed/retry` }),
      ),
    )
    expect(await screen.findByText('Письмо снова в очереди')).toBeVisible()
  })

  it('без права отправки — список без «Повторить»', async () => {
    stubApi({ [`/documents/${DOC}/emails`]: { items: [email('failed', 'failed')] } })
    renderSection(documentFixture(false))
    const list = await screen.findByRole('region', { name: 'Письма' })
    expect(within(list).queryByRole('button', { name: 'Повторить' })).toBeNull()
  })

  it('входящий без дела и отправок — раздела нет, писем не запрашивает', async () => {
    const calls = stubApi({})
    renderSection(documentFixture(true, 'incoming'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('region', { name: 'Письма' })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
