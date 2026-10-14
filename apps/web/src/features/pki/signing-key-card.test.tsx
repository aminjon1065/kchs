import type { PkiCertificateRecord } from '@kchs/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ME_ID, renderWithClient, stubApi } from '~/test/render.js'
import { createDeviceKey, deviceKeys, forgetDeviceKey } from './device-keys.js'
import { SigningKeyCard } from './signing-key-card.js'

/**
 * «Ключ подписи» в профиле (ADR-0218): ключ создаётся на устройстве с кодом второго
 * фактора, сертификаты видны с отметкой «это устройство», отзыв — с подтверждением.
 * WebCrypto и IndexedDB подменены: проверяется карточка, не браузер.
 */
vi.mock('./device-keys.js', () => ({
  createDeviceKey: vi.fn(),
  deviceKeys: vi.fn(),
  forgetDeviceKey: vi.fn(),
  DeviceKeyUnsupportedError: class extends Error {},
}))

const STATUS = {
  initialized: true,
  rootFingerprint: 'AB:CD',
  rootSubject: 'CN=Корневой УЦ Комитета',
  rootNotAfter: '2046-10-14T00:00:00.000Z',
  issuingNotAfter: '2036-10-14T00:00:00.000Z',
  active: 1,
}

const CERT: PkiCertificateRecord = {
  id: '00000000-0000-4000-8000-0000000000c1',
  serial: '0a1b',
  purpose: 'person',
  userId: ME_ID,
  userName: 'Сотрудник Проверочный',
  subject: 'CN=Сотрудник Проверочный',
  deviceLabel: 'Ноутбук отдела',
  fingerprint: 'EF',
  state: 'active',
  issuedAt: '2026-10-14T00:00:00.000Z',
  expiresAt: '2028-10-14T00:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
  certificate: 'MIIB',
}

beforeEach(() => {
  vi.mocked(createDeviceKey).mockReset()
  vi.mocked(deviceKeys).mockReset().mockResolvedValue([])
  vi.mocked(forgetDeviceKey).mockReset().mockResolvedValue(undefined)
})

describe('SigningKeyCard', () => {
  it('УЦ не создан — пояснение, создавать ключ негде', async () => {
    stubApi({ '/pki/status': { ...STATUS, initialized: false }, '/me/certificates': { items: [] } })
    renderWithClient(<SigningKeyCard userId={ME_ID} canSeal={false} mfaEnabled />)
    expect(await screen.findByText(/ещё не создан/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /Создать ключ/ })).toBeNull()
  })

  it('без второго фактора — просьба подключить его', async () => {
    stubApi({ '/pki/status': STATUS, '/me/certificates': { items: [] } })
    renderWithClient(<SigningKeyCard userId={ME_ID} canSeal={false} mfaEnabled={false} />)
    expect(await screen.findByText(/подключите второй фактор/)).toBeVisible()
  })

  it('ключ создаётся с кодом; печать — только у кого есть право', async () => {
    stubApi({ '/pki/status': STATUS, '/me/certificates': { items: [] } })
    vi.mocked(createDeviceKey).mockResolvedValue(CERT)
    const user = userEvent.setup()
    renderWithClient(<SigningKeyCard userId={ME_ID} canSeal mfaEnabled />)

    const create = await screen.findByRole('button', { name: 'Создать ключ на этом устройстве' })
    expect(create).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: 'Печать организации' }))
    await user.type(screen.getByLabelText('Название устройства'), 'Ноутбук отдела')
    await user.type(screen.getByLabelText('Код второго фактора'), '123456')
    await user.click(screen.getByRole('button', { name: 'Создать ключ печати на этом устройстве' }))

    await waitFor(() =>
      expect(createDeviceKey).toHaveBeenCalledWith({
        userId: ME_ID,
        purpose: 'seal',
        label: 'Ноутбук отдела',
        code: '123456',
      }),
    )
    expect(await screen.findByText('Ключ создан, сертификат выпущен')).toBeVisible()
  })

  it('сертификат этого устройства отмечен; отзыв удаляет и ключ устройства', async () => {
    const calls = stubApi({
      '/pki/status': STATUS,
      '/me/certificates': { items: [CERT] },
      [`POST /me/certificates/${CERT.id}/revoke`]: { ...CERT, state: 'revoked' },
    })
    vi.mocked(deviceKeys).mockResolvedValue([
      {
        id: CERT.id,
        userId: ME_ID,
        purpose: 'person',
        privateKey: {} as CryptoKey,
        certificate: CERT.certificate,
        fingerprint: CERT.fingerprint,
        issuedAt: CERT.issuedAt,
        expiresAt: CERT.expiresAt,
        label: CERT.deviceLabel,
      },
    ])
    const user = userEvent.setup()
    renderWithClient(<SigningKeyCard userId={ME_ID} canSeal={false} mfaEnabled />)

    expect(await screen.findByText('Ноутбук отдела')).toBeVisible()
    expect(await screen.findByText('Это устройство')).toBeVisible()
    expect(screen.queryByRole('radio', { name: 'Печать организации' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Отозвать' }))
    expect(screen.getByText('Отозвать сертификат «Ноутбук отдела»?')).toBeVisible()
    await user.click(screen.getAllByRole('button', { name: 'Отозвать' }).at(-1) as HTMLElement)

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `/me/certificates/${CERT.id}/revoke`,
        body: {},
      }),
    )
    await waitFor(() => expect(forgetDeviceKey).toHaveBeenCalledWith(CERT.id))
  })
})
