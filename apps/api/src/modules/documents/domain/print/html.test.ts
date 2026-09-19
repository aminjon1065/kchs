import { describe, expect, it } from 'vitest'
import { escapeHtml, html, multiline, printPage, SafeHtml } from './html.js'
import { watermarkOverlay } from './watermark-overlay.js'

describe('HTML печатных форм', () => {
  it('подстановки экранируются всегда', () => {
    const subject = '<img src=x onerror=alert(1)> «Смета» & "план"'
    expect(html`<td>${subject}</td>`.value).toBe(
      '<td>&lt;img src=x onerror=alert(1)&gt; «Смета» &amp; &quot;план&quot;</td>',
    )
    expect(escapeHtml("O'Neil")).toBe('O&#39;Neil')
  })

  it('фрагменты, собранные html, вставляются как есть; массивы склеиваются', () => {
    const rows = ['а<б', 'в'].map((value) => html`<li>${value}</li>`)
    expect(html`<ul>${rows}</ul>`.value).toBe('<ul><li>а&lt;б</li><li>в</li></ul>')
    expect(html`${null}${undefined}${false}${0}`.value).toBe('0')
  })

  it('многострочный текст — через <br>, без разметки из текста', () => {
    expect(multiline('строка 1\n<b>строка 2</b>').value).toBe(
      'строка 1<br>&lt;b&gt;строка 2&lt;/b&gt;',
    )
  })

  it('страница формы: заголовок экранирован, стили — свои, без внешних ресурсов', () => {
    const page = printPage({
      title: '</title><script>',
      lang: 'ru',
      body: new SafeHtml('<p>x</p>'),
    })
    expect(page).toContain('<title>&lt;/title&gt;&lt;script&gt;</title>')
    expect(page).not.toMatch(/<script|<link|https?:\/\//)
  })

  it('водяной знак: строки экранированы и повторены по всему листу', () => {
    const overlay = watermarkOverlay('ru', ['Конфиденциально', '<Иванов>', '20.09.2026 10:00'])
    expect(overlay).toContain('&lt;Иванов&gt;')
    expect(overlay).not.toContain('<Иванов>')
    expect(overlay.match(/class="tile"/g)).toHaveLength(18)
  })
})
