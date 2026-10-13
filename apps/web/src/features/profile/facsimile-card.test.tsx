import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { FacsimileCard } from './facsimile-card.js'

/**
 * «Факсимиле» в профиле (ADR-0198): PNG до 256 КБ, проверка до отправки, предпросмотр
 * своей подписи и удаление с подтверждением.
 */
const NONE = {
  present: false,
  dataUri: null,
  width: null,
  height: null,
  updatedAt: null,
  updatedBy: null,
}
const SAVED = {
  present: true,
  dataUri: 'data:image/png;base64,iVBORw0KGgo=',
  width: 240,
  height: 96,
  updatedAt: '2026-10-13T08:00:00.000Z',
  updatedBy: { id: 'u1', displayName: 'Сотрудник Проверочный', avatarUrl: null },
}

const png = (size = 64) =>
  new File([new Uint8Array(size).fill(1)], 'подпись.png', { type: 'image/png' })

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('нет поля файла')
  return input
}

describe('FacsimileCard', () => {
  it('нет факсимиле — пояснение и загрузка; удалять нечего', async () => {
    stubApi({ '/me/facsimile': NONE })
    renderWithClient(<FacsimileCard />)
    expect(await screen.findByText(/Факсимиле не загружено/)).toBeVisible()
    expect(screen.getByText('Загрузить PNG с подписью')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Удалить факсимиле' })).toBeNull()
  })

  it('не PNG и слишком большой файл — отказ до отправки', async () => {
    const calls = stubApi({ '/me/facsimile': NONE })
    const user = userEvent.setup({ applyAccept: false })
    renderWithClient(<FacsimileCard />)
    await screen.findByText(/Факсимиле не загружено/)

    await user.upload(fileInput(), new File(['GIF89a'], 'подпись.gif', { type: 'image/gif' }))
    expect(await screen.findByText('Нужен файл PNG')).toBeVisible()
    await user.upload(fileInput(), png(256 * 1024 + 1))
    expect(await screen.findByText('Файл больше 256 КБ')).toBeVisible()
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
  })

  it('PNG уходит base64 и сразу виден в предпросмотре', async () => {
    const calls = stubApi({ '/me/facsimile': NONE, 'PUT /me/facsimile': SAVED })
    const user = userEvent.setup()
    renderWithClient(<FacsimileCard />)
    await screen.findByText(/Факсимиле не загружено/)

    await user.upload(fileInput(), png(3))
    expect(await screen.findByRole('img', { name: 'Факсимиле' })).toHaveAttribute(
      'src',
      SAVED.dataUri,
    )
    expect(calls).toContainEqual({ method: 'PUT', path: '/me/facsimile', body: { png: 'AQEB' } })
    expect(screen.getByText('Заменить факсимиле')).toBeVisible()
  })

  it('удаление — только после подтверждения', async () => {
    const calls = stubApi({ '/me/facsimile': SAVED, 'DELETE /me/facsimile': NONE })
    const user = userEvent.setup()
    renderWithClient(<FacsimileCard />)
    await user.click(await screen.findByRole('button', { name: 'Удалить факсимиле' }))
    expect(screen.getByText('Удалить факсимиле?')).toBeVisible()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)

    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить факсимиле' }),
    )
    await waitFor(() => expect(screen.getByText(/Факсимиле не загружено/)).toBeVisible())
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/me/facsimile' }),
    )
  })
})
