import { describe, expect, it } from 'vitest'
import { deniedAddress } from './raster-fetch.js'

/** Прокси растровых подложек не ходит во внутренние адреса (ADR-0066, SSRF). */
describe('адреса растрового прокси', () => {
  it('link-local (метаданные облака), «этот узел», multicast и IPv6-аналоги закрыты', () => {
    for (const address of [
      '169.254.169.254',
      '::ffff:169.254.169.254',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      'fe80::1',
      'ff02::1',
      'не адрес',
    ]) {
      expect(deniedAddress(address), address).toBe(true)
    }
  })

  it('частные сети закрытого контура и внешние адреса открыты', () => {
    for (const address of [
      '10.0.0.5',
      '172.20.1.2',
      '192.168.1.10',
      '8.8.8.8',
      'fd00::1',
      '2a00::1',
    ]) {
      expect(deniedAddress(address), address).toBe(false)
    }
  })
})
