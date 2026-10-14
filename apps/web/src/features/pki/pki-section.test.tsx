import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { PkiSection } from './pki-section.js'

/**
 * «УЦ Комитета» в консоли (ADR-0218): создание один раз с подтверждением, состояние с
 * отпечатком корня, сертификаты сотрудников с отзывом.
 */
const READY = {
  initialized: true,
  rootFingerprint: '12:34:AB',
  rootSubject: 'CN=Корневой УЦ Комитета, O=Комитет',
  rootNotAfter: '2046-10-14T00:00:00.000Z',
  issuingNotAfter: '2036-10-14T00:00:00.000Z',
  active: 1,
  issuers: [
    {
      fingerprint: 'ab'.repeat(32),
      path: 'issuing',
      notAfter: '2036-10-14T00:00:00.000Z',
      current: true,
      retiredAt: null,
      reason: null,
      revokedAt: null,
    },
  ],
  tsaNotAfter: '2031-10-14T00:00:00.000Z',
  expiring: [] as Array<{ kind: string; notAfter: string }>,
}

const SEAL = {
  id: '00000000-0000-4000-8000-0000000000c2',
  serial: '0c',
  purpose: 'seal',
  userId: '00000000-0000-4000-8000-000000000002',
  userName: 'Делопроизводитель',
  subject: 'CN=Комитет, O=Комитет',
  deviceLabel: 'Канцелярия',
  fingerprint: 'AA',
  state: 'active',
  issuedAt: '2026-10-14T00:00:00.000Z',
  expiresAt: '2028-10-14T00:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
  certificate: 'MIIB',
}

describe('PkiSection', () => {
  it('УЦ создаётся только после подтверждения', async () => {
    const calls = stubApi({
      '/pki/status': { ...READY, initialized: false, rootFingerprint: null },
      'POST /admin/pki/init': READY,
    })
    const user = userEvent.setup()
    renderWithClient(<PkiSection canInit canManage />)

    await user.click(await screen.findByRole('button', { name: 'Создать УЦ Комитета' }))
    expect(screen.getByText('Создать удостоверяющий центр Комитета?')).toBeVisible()
    expect(calls.some((call) => call.path === '/admin/pki/init')).toBe(false)
    await user.click(
      screen.getAllByRole('button', { name: 'Создать УЦ Комитета' }).at(-1) as HTMLElement,
    )

    expect(await screen.findByText('12:34:AB')).toBeVisible()
    expect(calls.some((call) => call.method === 'POST' && call.path === '/admin/pki/init')).toBe(
      true,
    )
  })

  it('без права администратора системы создать УЦ нельзя', async () => {
    stubApi({ '/pki/status': { ...READY, initialized: false } })
    renderWithClient(<PkiSection canInit={false} canManage />)
    expect(await screen.findByText(/ещё не создан/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Создать УЦ Комитета' })).toBeNull()
  })

  it('срок ключей — предупреждение; смена ключа — с причиной и основанием', async () => {
    const calls = stubApi({
      '/pki/status': {
        ...READY,
        expiring: [{ kind: 'issuing', notAfter: '2027-01-10T00:00:00.000Z' }],
      },
      '/admin/pki/certificates': { items: [] },
      'POST /admin/pki/rotate': READY,
    })
    const user = userEvent.setup()
    renderWithClient(<PkiSection canInit canManage />)

    expect(await screen.findByText(/подходит к концу/)).toHaveTextContent('выпускающий')
    await user.click(screen.getByRole('button', { name: 'Сменить ключ' }))
    expect(screen.getByText('Сменить ключ выпускающего УЦ?')).toBeVisible()
    await user.type(screen.getByRole('textbox'), 'Приказ № 12')
    await user.click(screen.getAllByRole('button', { name: 'Сменить ключ' }).at(-1) as HTMLElement)
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/admin/pki/rotate',
        body: { mode: 'planned', reason: 'Приказ № 12' },
      }),
    )
  })

  it('сертификат печати виден и отзывается', async () => {
    const calls = stubApi({
      '/pki/status': READY,
      '/admin/pki/certificates': { items: [SEAL] },
      [`POST /admin/pki/certificates/${SEAL.id}/revoke`]: { ...SEAL, state: 'revoked' },
    })
    const user = userEvent.setup()
    renderWithClient(<PkiSection canInit canManage />)

    expect(await screen.findByText('Печать организации · Делопроизводитель')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Отозвать' }))
    await user.click(screen.getAllByRole('button', { name: 'Отозвать' }).at(-1) as HTMLElement)
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `/admin/pki/certificates/${SEAL.id}/revoke`,
        body: {},
      }),
    )
  })
})
