import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAll } from '~/shared/offline/store.js'
import { meFixture, renderWithClient, stubApi } from '~/test/render.js'
import { ReportDialog } from './report-dialog.js'

/**
 * «Донесение» (ADR-0212): создание с ключом устройства; без сети донесение ложится в
 * очередь устройства с тем же ключом и диалог закрывается; без типа «Донесение» —
 * объяснение вместо формы.
 */
const TYPE_ID = '00000000-0000-4000-8000-00000000a001'
const reportType = {
  id: TYPE_ID,
  key: 'situation_report',
  name: { ru: 'Донесение' },
  direction: 'incoming',
  cardSchema: { fields: [] },
  isActive: true,
}

afterEach(() => vi.restoreAllMocks())

function render(types: unknown[], post: (body: unknown) => unknown) {
  const calls = stubApi({
    '/me': meFixture(),
    '/document-types': { items: types },
    'POST /documents': ({ init }: { init: RequestInit | undefined }) =>
      post(JSON.parse(String(init?.body))),
    'POST /documents/doc-1/intake': { state: 'sent', instanceId: null },
  })
  const onClose = vi.fn()
  renderWithClient(<ReportDialog onClose={onClose} />)
  return { calls, onClose }
}

describe('ReportDialog', () => {
  it('без типа «Донесение» — объяснение, а не форма', async () => {
    render([], () => ({ id: 'x' }))
    expect(await screen.findByText(/Тип «Донесение» не найден/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull()
  })

  it('со связью — создаёт документ с ключом устройства и отправляет дежурной смене', async () => {
    const user = userEvent.setup()
    const { calls, onClose } = render([reportType], () => ({ id: 'doc-1' }))
    await user.type(await screen.findByLabelText('Кратко о происшествии'), 'Подмыт мост')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const created = calls.find((call) => call.method === 'POST' && call.path === '/documents')
    expect(created?.body).toMatchObject({ typeId: TYPE_ID, subject: 'Подмыт мост' })
    expect((created?.body as { clientKey?: string } | undefined)?.clientKey).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    // После создания — на регистрацию (ADR-0212)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      'POST /documents/doc-1/intake',
    )
    expect(
      await screen.findByText('Донесение отправлено дежурной смене на регистрацию'),
    ).toBeInTheDocument()
  })

  it('без сети — донесение в очереди устройства тем же ключом, диалог закрыт', async () => {
    const user = userEvent.setup()
    const keys: string[] = []
    const { onClose } = render([reportType], (body) => {
      keys.push((body as { clientKey: string }).clientKey)
      throw new TypeError('Failed to fetch')
    })
    await user.type(await screen.findByLabelText('Кратко о происшествии'), 'Сель в кишлаке')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const entries = await readAll<{ id: string; kind: string; title: string }>('queue')
    expect(entries).toContainEqual(
      expect.objectContaining({ id: keys[0], kind: 'document.create', title: 'Сель в кишлаке' }),
    )
  })
})
