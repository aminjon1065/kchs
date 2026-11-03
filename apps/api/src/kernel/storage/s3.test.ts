import { describe, expect, it } from 'vitest'
import { inlineSafe, signedGetUrl } from './s3.js'

/**
 * Показ файла на месте (ADR-0225): HTML, SVG и прочее, что браузер исполнил бы
 * как страницу на адресе хранилища, отдаётся только вложением.
 */
describe('показ файла на месте', () => {
  it('безопасны растровые изображения, PDF, видео, звук и простой текст', () => {
    for (const type of [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'video/mp4',
      'text/plain; charset=utf-8',
    ]) {
      expect(inlineSafe(type)).toBe(true)
    }
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/xml',
      'text/javascript',
      '',
      undefined,
    ]) {
      expect(inlineSafe(type)).toBe(false)
    }
  })

  it('HTML по просьбе показать на месте всё равно скачивается', async () => {
    const url = new URL(
      await signedGetUrl('spaces/s/files/f/v/page.html', {
        filename: 'page.html',
        inline: true,
        contentType: 'text/html',
      }),
    )
    expect(url.searchParams.get('response-content-disposition')).toMatch(/^attachment;/)
    expect(url.searchParams.get('response-content-type')).toBeNull()
  })

  it('изображение показывается на месте с типом, который знает сервер', async () => {
    const url = new URL(
      await signedGetUrl('spaces/s/files/f/v/photo.jpg', {
        filename: 'photo.jpg',
        inline: true,
        contentType: 'image/jpeg',
      }),
    )
    expect(url.searchParams.get('response-content-disposition')).toMatch(/^inline;/)
    expect(url.searchParams.get('response-content-type')).toBe('image/jpeg')
  })
})
