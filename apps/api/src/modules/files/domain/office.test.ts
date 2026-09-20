import { describe, expect, it, vi } from 'vitest'
import { checkTicket, officeDocumentType, officeTicket, signJwt, verifyJwt } from './office.js'
import { officeEditorConfig, renderOfficePage } from './office-page.js'

/**
 * Подпись и пропуска для сервера документов (ADR-0112). Формат JWT здесь не
 * внутреннее дело: его читает посторонняя служба, поэтому проверяется и
 * разбор своей подписи, и отказ от чужой.
 */

const SECRET = 'секрет-установки-0123456789'

describe('подпись запросов к серверу документов', () => {
  it('своя подпись читается, чужая и просроченная — нет', () => {
    const token = signJwt({ status: 2, url: 'http://ds/cache/x.docx' }, SECRET, 60)

    expect(verifyJwt(token, SECRET)).toMatchObject({ status: 2, url: 'http://ds/cache/x.docx' })
    expect(verifyJwt(token, 'другой-секрет')).toBeNull()
    expect(verifyJwt('не.токен.вовсе', SECRET)).toBeNull()

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 120_000)
      expect(verifyJwt(token, SECRET)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('пропуск действует только для своей сессии, своей цели и своего срока', () => {
    const ticket = officeTicket('session-1', 'content', SECRET, 60_000)

    expect(checkTicket(ticket, 'session-1', 'content', SECRET)).toBe(true)
    expect(checkTicket(ticket, 'session-2', 'content', SECRET)).toBe(false)
    expect(checkTicket(ticket, 'session-1', 'callback', SECRET)).toBe(false)
    expect(checkTicket(ticket, 'session-1', 'content', 'другой-секрет')).toBe(false)
    expect(checkTicket('123.abc', 'session-1', 'content', SECRET)).toBe(false)

    const expired = officeTicket('session-1', 'content', SECRET, -1000)
    expect(checkTicket(expired, 'session-1', 'content', SECRET)).toBe(false)
  })
})

describe('конфигурация редактора', () => {
  const base = {
    title: 'Приказ.docx',
    documentType: 'word' as const,
    documentKey: 'key1',
    fileName: 'Приказ.docx',
    contentUrl: 'http://api/internal/office/s/content?t=1.2',
    callbackUrl: 'http://api/internal/office/s/callback?t=1.2',
    lang: 'ru',
    user: { id: 'u1', name: 'Тестов Т.' },
  }

  it('вид документа определяется по расширению', () => {
    expect(officeDocumentType('Приказ.docx')).toBe('word')
    expect(officeDocumentType('Смета.XLSX')).toBe('cell')
    expect(officeDocumentType('Доклад.pptx')).toBe('slide')
    expect(officeDocumentType('скан.pdf')).toBeNull()
  })

  it('только чтение: правка запрещена и адреса сохранения нет', () => {
    const view = officeEditorConfig({ ...base, mode: 'view', callbackUrl: null })

    expect(view.document.permissions.edit).toBe(false)
    expect(view.editorConfig.mode).toBe('view')
    expect('callbackUrl' in view.editorConfig).toBe(false)
  })

  it('правка: сохранение включено, скачивание и печать идут своим путём', () => {
    const edit = officeEditorConfig({ ...base, mode: 'edit' })

    expect(edit.document.permissions.edit).toBe(true)
    expect(edit.document.permissions.download).toBe(false)
    expect(edit.document.permissions.print).toBe(false)
    expect(edit.editorConfig.callbackUrl).toBe(base.callbackUrl)
  })

  it('страница несёт подписанную конфигурацию и не даёт разорвать тег скрипта', () => {
    const page = renderOfficePage({
      ...base,
      mode: 'edit',
      serverUrl: 'http://ds:8082',
      nonce: 'n1',
      failedText: '</script><img src=x>',
      token: signJwt(officeEditorConfig({ ...base, mode: 'edit' }), SECRET, 60),
    })

    expect(page).toContain('http://ds:8082/web-apps/apps/api/documents/api.js')
    expect(page).toContain('<script nonce="n1">')
    // Единственные теги скрипта — наши три; текст ошибки экранирован
    expect(page.match(/<script/g)).toHaveLength(3)
    expect(page).toContain('&lt;/script&gt;&lt;img src=x&gt;')
  })
})
