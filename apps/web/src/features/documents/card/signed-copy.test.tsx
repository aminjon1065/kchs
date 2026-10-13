import type { DocumentRecord, DocumentSignature } from '@kchs/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { DocumentProvider } from './document-context.js'
import { SignatureRequisites, SignedCopyRow, verifyHref } from './signed-copy.js'

/**
 * Подпись как реквизит в карточке (ADR-0198): подписанный экземпляр у версии, ссылка
 * проверки — та же, что в QR штампа, место факсимиле правит только тот, кому можно.
 */
const DOC = '00000000-0000-4000-8000-00000000d0c1'
const SIG = '00000000-0000-4000-8000-00000000519a'
const PDF = '00000000-0000-4000-8000-0000000000f1'

function documentFixture(version: Record<string, unknown>): DocumentRecord {
  return { id: DOC, currentVersion: { id: 'v1', ...version } } as unknown as DocumentRecord
}

function signatureFixture(overrides: Partial<DocumentSignature> = {}): DocumentSignature {
  return {
    id: SIG,
    kind: 'simple',
    facsimile: true,
    canPlace: true,
    current: true,
    placement: null,
    ...overrides,
  } as DocumentSignature
}

function inDocument(document: DocumentRecord, ui: React.ReactElement) {
  return renderWithClient(
    <DocumentProvider document={document} tabId={null}>
      {ui}
    </DocumentProvider>,
  )
}

describe('SignedCopyRow', () => {
  it('без подписи строки нет; подписан — «готовится», пока движок строит экземпляр', () => {
    const { rerender } = inDocument(
      documentFixture({ signedCopy: null }),
      <SignedCopyRow signed={false} />,
    )
    expect(screen.queryByText(/Подписанный экземпляр/)).toBeNull()
    rerender(
      <DocumentProvider document={documentFixture({ signedCopy: null })} tabId={null}>
        <SignedCopyRow signed />
      </DocumentProvider>,
    )
    expect(screen.getByText('Подписанный экземпляр готовится')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Скачать' })).toBeNull()
  })

  it('готовый экземпляр скачивается своей версией файла', async () => {
    const calls = stubApi({ '/files/copy-1/download': { url: '/files/x', filename: 'x.pdf' } })
    inDocument(
      documentFixture({ signedCopy: { id: 'copy-1', versionId: 'fv-2', mime: 'application/pdf' } }),
      <SignedCopyRow signed />,
    )
    expect(screen.getByText('Подписанный экземпляр — с факсимиле и штампом подписи')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Скачать' }))
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'GET', path: '/files/copy-1/download' }),
      ),
    )
  })
})

describe('SignatureRequisites', () => {
  it('ссылка проверки — адрес QR штампа; открывается без доступа к окну карточки', async () => {
    expect(verifyHref(SIG)).toBe(`/api/v1/verify/${SIG}`)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    inDocument(
      documentFixture({ pdfFile: { id: PDF } }),
      <SignatureRequisites signature={signatureFixture()} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Проверка по QR' }))
    expect(open).toHaveBeenCalledWith(`/api/v1/verify/${SIG}`, '_blank', 'noopener')
    expect(screen.getByText('С факсимиле')).toBeVisible()
  })

  it('место факсимиле — только с правом, у текущей версии и при готовом PDF', () => {
    const doc = documentFixture({ pdfFile: { id: PDF } })
    const { rerender } = inDocument(
      doc,
      <SignatureRequisites signature={signatureFixture({ canPlace: false })} />,
    )
    expect(screen.queryByRole('button', { name: 'Место факсимиле' })).toBeNull()
    for (const [document, signature] of [
      [doc, signatureFixture({ current: false })],
      [documentFixture({ pdfFile: null }), signatureFixture()],
    ] as const) {
      rerender(
        <DocumentProvider document={document} tabId={null}>
          <SignatureRequisites signature={signature} />
        </DocumentProvider>,
      )
      expect(screen.queryByRole('button', { name: 'Место факсимиле' })).toBeNull()
    }
    // Простая подпись не перепроверяется движком — это делает только КЭП
    expect(screen.queryByRole('button', { name: /Проверить заново/ })).toBeNull()
  })

  it('щелчок по листу — доля листа; сохранение отправляет лист и точку', async () => {
    const calls = stubApi({
      [`/files/${PDF}/previews`]: {
        items: [
          { kind: 'page', page: 1, url: '/p1.png' },
          { kind: 'page', page: 2, url: '/p2.png' },
        ],
      },
      [`PUT /documents/${DOC}/signatures/${SIG}/placement`]: { placement: { source: 'manual' } },
    })
    inDocument(
      documentFixture({ pdfFile: { id: PDF } }),
      <SignatureRequisites signature={signatureFixture()} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Место факсимиле' }))
    const save = await screen.findByRole('button', { name: 'Сохранить' })
    expect(save).toBeDisabled()
    // По умолчанию — последний лист, как у штампа
    expect(await screen.findByRole('button', { name: 'Лист 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    const sheet = screen.getByRole('button', { name: 'Поставить факсимиле в это место листа' })
    sheet.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 600 }) as DOMRect
    fireEvent.click(sheet, { clientX: 300, clientY: 500 })
    await userEvent.click(save)

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/documents/${DOC}/signatures/${SIG}/placement`,
        body: { page: 2, x: 0.5, y: 0.75 },
      }),
    )
  })
})
