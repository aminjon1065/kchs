import type { DocumentRecord } from '@kchs/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { DocumentProvider } from './document-context.js'
import { GovEdmsSection } from './gov-edms-section.js'

/**
 * Исходящий в госЭДО на «Карточке» (ADR-0219): пока передачи нет — пакет и отметка,
 * отметка уходит с датой и номером в госсистеме; адресат без госЭДО — блока нет.
 */
const DOC = '00000000-0000-4000-8000-00000000e0d5'

function documentFixture(status = 'registered', canDispatch = true): DocumentRecord {
  return {
    id: DOC,
    status,
    type: { direction: 'outgoing' },
    can: { dispatch: canDispatch },
  } as unknown as DocumentRecord
}

const recipient = {
  id: '00000000-0000-4000-8000-0000000000c1',
  kind: 'organization',
  name: 'Министерство финансов',
}

function renderSection(document: DocumentRecord) {
  return renderWithClient(
    <DocumentProvider document={document} tabId={null}>
      <GovEdmsSection />
    </DocumentProvider>,
  )
}

describe('GovEdmsSection', () => {
  it('ждёт передачи: отметка уходит с датой и номером в госЭДО', async () => {
    const calls = stubApi({
      [`/documents/${DOC}/gov-edms`]: { exchange: true, recipient, pending: true, transfers: [] },
      [`POST /documents/${DOC}/gov-edms/transferred`]: {
        dispatchId: '00000000-0000-4000-8000-0000000000d1',
      },
    })
    const user = userEvent.setup()
    renderSection(documentFixture())
    expect(await screen.findByText('Ждёт передачи в госЭДО')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Скачать пакет для госЭДО' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Отметить: передано' }))
    const mark = screen.getByRole('dialog', { name: 'Передано в госЭДО' })
    const submit = screen.getAllByRole('button', { name: 'Отметить: передано' }).at(-1)
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText('Номер в госЭДО'), 'ГЭ-77')
    await user.click(submit as HTMLElement)
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/gov-edms/transferred'))?.body).toMatchObject(
        { externalNumber: 'ГЭ-77', note: null },
      ),
    )
    expect(mark).toBeDefined()
  })

  it('адресат без госЭДО и без передач — блока нет; без права отправки — без кнопок', async () => {
    stubApi({
      [`/documents/${DOC}/gov-edms`]: { exchange: false, recipient, pending: false, transfers: [] },
    })
    const { unmount } = renderSection(documentFixture())
    await waitFor(() => expect(screen.queryByText('госЭДО')).toBeNull())
    unmount()

    stubApi({
      [`/documents/${DOC}/gov-edms`]: { exchange: true, recipient, pending: true, transfers: [] },
    })
    renderSection(documentFixture('registered', false))
    expect(await screen.findByText('Ждёт передачи в госЭДО')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Отметить: передано' })).toBeNull()
  })
})
