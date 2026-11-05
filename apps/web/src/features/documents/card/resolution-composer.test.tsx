import type { DocumentRecord } from '@kchs/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi, testQueryClient } from '~/test/render.js'
import { DocumentProvider } from './document-context.js'
import { ResolutionComposer } from './resolution-composer.js'

/**
 * Резолюция внизу карточки (ADR-0230): форма — только у того, кому направлен документ;
 * «Наложить» — когда заполнены текст, ответственный и срок; «Все параметры» продолжает
 * с набранного в полном диалоге.
 */
const DOCUMENT_ID = '00000000-0000-4000-8000-00000000d0c2'

function documentFixture(patch: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: DOCUMENT_ID,
    subject: 'Донесение о сходе лавины',
    regNumber: 'ВХ/214',
    type: { settings: { allowResolutions: true }, cardSchema: { fields: [] } },
    ...patch,
  } as unknown as DocumentRecord
}

function resolutions(can: { resolve: boolean; request: boolean }) {
  return {
    items: [],
    requests: [],
    can: { resolveOnBehalf: false, noExecution: false, ...can },
    defaultAuthor: null,
  }
}

function renderComposer(document: DocumentRecord, can: { resolve: boolean; request: boolean }) {
  const calls = stubApi({
    [`/documents/${DOCUMENT_ID}/resolutions`]: resolutions(can),
    [`/objects/${DOCUMENT_ID}/acknowledgments`]: {
      summary: { total: 0, acknowledged: 0, pending: 0 },
      mine: { pending: false, requireSecondFactor: false },
      can: { send: false, remind: false },
      items: [],
    },
    '/resolution-templates': { items: [] },
  })
  renderWithClient(
    <DocumentProvider document={document} tabId={null}>
      <ResolutionComposer />
    </DocumentProvider>,
    testQueryClient(),
  )
  return calls
}

describe('ResolutionComposer', () => {
  it('нет открытого направления — формы нет; незарегистрированный документ не спрашивает', async () => {
    const calls = renderComposer(documentFixture(), { resolve: false, request: true })
    await waitFor(() =>
      expect(calls.map((call) => call.path)).toContain(`/documents/${DOCUMENT_ID}/resolutions`),
    )
    expect(screen.queryByRole('form', { name: 'Резолюция' })).toBeNull()

    const draft = renderComposer(documentFixture({ regNumber: null }), {
      resolve: true,
      request: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(draft.map((call) => call.path)).not.toContain(`/documents/${DOCUMENT_ID}/resolutions`)
  })

  it('«Наложить» ждёт заполнения; ⌘↵ на пустой форме ничего не отправляет', async () => {
    const calls = renderComposer(documentFixture(), { resolve: true, request: true })
    const form = await screen.findByRole('form', { name: 'Резолюция' })
    const submit = within(form).getByRole('button', { name: 'Наложить резолюцию' })
    expect(submit).toBeDisabled()
    expect(within(form).getByRole('button', { name: 'Переадресовать' })).toBeVisible()

    fireEvent.keyDown(within(form).getByRole('textbox', { name: /^Текст резолюции/ }), {
      key: 'Enter',
      ctrlKey: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('без права направлять — без «Переадресовать»; «Все параметры» продолжает с набранного', async () => {
    renderComposer(documentFixture(), { resolve: true, request: false })
    const form = await screen.findByRole('form', { name: 'Резолюция' })
    expect(within(form).queryByRole('button', { name: 'Переадресовать' })).toBeNull()

    await userEvent.type(
      within(form).getByRole('textbox', { name: /^Текст резолюции/ }),
      'Организовать дежурство техники',
    )
    await userEvent.click(within(form).getByRole('button', { name: 'Все параметры' }))
    const dialog = await screen.findByRole('dialog', { name: 'Наложить резолюцию' })
    expect(within(dialog).getByRole('textbox', { name: /^Текст резолюции/ })).toHaveValue(
      'Организовать дежурство техники',
    )
  })
})
