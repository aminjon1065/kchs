import { html, overlayPage, type SafeHtml } from './html.js'

/** Полупрозрачный красный текст по диагонали — читается, но не закрывает содержимое. */
const WATERMARK_CSS = `
.tile { position: absolute; transform: rotate(-30deg); transform-origin: center;
  color: rgba(170, 20, 20, 0.17); font-family: 'DejaVu Sans', sans-serif; font-size: 13pt;
  font-weight: bold; white-space: nowrap; text-align: center; line-height: 1.35; }
`

/**
 * Водяной знак копии файла с грифом (08-documents.md §13, ADR-0085): строки
 * (гриф, кто, когда) плиткой по всему листу — со смещением через ряд, чтобы
 * знак нельзя было обрезать полями.
 */
export function watermarkOverlay(lang: string, lines: string[]): string {
  const text: SafeHtml[] = lines.map((line, index) =>
    index === 0 ? html`${line}` : html`<br>${line}`,
  )
  const tiles: SafeHtml[] = []
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const top = 3 + row * 17
      const left = -12 + col * 40 + (row % 2) * 20
      tiles.push(html`<div class="tile" style="top: ${top}%; left: ${left}%">${text}</div>`)
    }
  }
  return overlayPage({ lang, css: WATERMARK_CSS, body: html`${tiles}` })
}
