import { describe, expect, it } from 'vitest'
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN, highlightedSnippet } from './snippet.js'

describe('сниппет поиска по базе знаний', () => {
  it('HTML страницы экранируется, подсветка становится <mark>', () => {
    const text = `до <img src=x onerror=alert(1)> ${HIGHLIGHT_OPEN}паводок${HIGHLIGHT_CLOSE} & после`
    expect(highlightedSnippet(text)).toBe(
      'до &lt;img src=x onerror=alert(1)&gt; <mark>паводок</mark> &amp; после',
    )
  })

  it('свои теги <mark> в тексте страницы остаются текстом', () => {
    expect(highlightedSnippet('<mark>не подсветка</mark>')).toBe(
      '&lt;mark&gt;не подсветка&lt;/mark&gt;',
    )
  })
})
