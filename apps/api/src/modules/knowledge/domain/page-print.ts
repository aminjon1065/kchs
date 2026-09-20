import type { PageBlock } from '@kchs/contracts'
import { safeHref } from '@kchs/contracts'
import { inArray } from 'drizzle-orm'
import { getObjectStream } from '~/kernel/storage/s3.js'
import {
  DocumentsPrint,
  type PrintBuild,
  type PrintContext,
  type PrintSubject,
} from '~/modules/documents/public.js'
import { fileBriefs, fileBuckets } from '~/modules/files/public.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { loadPage } from './page-core.js'

/**
 * Печать страницы базы знаний (ADR-0095): печатная форма реестра форм
 * (ADR-0085) — api собирает разметку, Chromium движка печатает её в PDF.
 * Сеть страницы печати закрыта, поэтому картинки вставляются в разметку
 * данными; встроенные объекты (график, карта, датасет, показатель, список
 * задач) в PDF не рисуются — на их месте ссылка на объект.
 */

const { html, multiline } = DocumentsPrint
type Safe = ReturnType<typeof html>

/** Картинку крупнее не вставляем: PDF собирается в памяти движка. */
const IMAGE_BYTES = 1_500_000

/** Название файла печати: «Страница — <название>.pdf». */
function fileNameOf(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return `${(clean || 'page').slice(0, 80)}.pdf`
}

interface JsonNode {
  type?: unknown
  text?: unknown
  attrs?: unknown
  marks?: unknown
  content?: unknown
}

function children(node: JsonNode): JsonNode[] {
  return Array.isArray(node.content)
    ? node.content.filter((child): child is JsonNode => typeof child === 'object' && child !== null)
    : []
}

/** Строчный узел Tiptap: текст с метками из белого списка (ADR-0018). */
function inline(node: JsonNode): Safe {
  if (node.type === 'hardBreak') return html`<br>`
  if (typeof node.text !== 'string') {
    return html`${children(node).map(inline)}`
  }
  let out = html`${node.text}`
  const marks = Array.isArray(node.marks) ? node.marks : []
  for (const raw of marks) {
    const mark = raw as { type?: unknown; attrs?: { href?: unknown } }
    if (mark.type === 'bold') out = html`<strong>${out}</strong>`
    else if (mark.type === 'italic') out = html`<em>${out}</em>`
    else if (mark.type === 'underline') out = html`<u>${out}</u>`
    else if (mark.type === 'strike') out = html`<s>${out}</s>`
    else if (mark.type === 'code') out = html`<code class="mono">${out}</code>`
    else if (mark.type === 'link') {
      const href = safeHref(mark.attrs?.href)
      if (href) out = html`<a href="${href}">${out}</a>`
    }
  }
  return out
}

/** Блочный узел Tiptap: абзацы, заголовки, списки, цитаты, код. */
function block(node: JsonNode): Safe {
  const inner = html`${children(node).map((child) => (isBlock(child) ? block(child) : inline(child)))}`
  switch (node.type) {
    case 'heading': {
      const level = (node.attrs as { level?: unknown } | undefined)?.level
      // h1 печатной формы занят названием страницы: заголовки текста на уровень ниже
      const tag = typeof level === 'number' && level >= 1 && level <= 4 ? level + 1 : 3
      if (tag === 2) return html`<h2>${inner}</h2>`
      if (tag === 3) return html`<h3>${inner}</h3>`
      if (tag === 4) return html`<h4>${inner}</h4>`
      return html`<h5>${inner}</h5>`
    }
    case 'bulletList':
      return html`<ul>${inner}</ul>`
    case 'orderedList':
      return html`<ol>${inner}</ol>`
    case 'listItem':
      return html`<li>${inner}</li>`
    case 'blockquote':
      return html`<blockquote>${inner}</blockquote>`
    case 'codeBlock':
      return html`<pre class="mono">${inner}</pre>`
    case 'horizontalRule':
      return html`<hr>`
    default:
      return html`<p>${inner}</p>`
  }
}

const BLOCK_NODES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
])

function isBlock(node: JsonNode): boolean {
  return typeof node.type === 'string' && BLOCK_NODES.has(node.type)
}

function richBody(body: { content?: unknown }): Safe {
  const nodes = Array.isArray(body.content)
    ? body.content.filter((n): n is JsonNode => typeof n === 'object' && n !== null)
    : []
  return html`${nodes.map((node) => (isBlock(node) ? block(node) : html`<p>${inline(node)}</p>`))}`
}

/** Картинка данными: только изображение и только небольшое. */
async function imageData(fileId: string): Promise<string | null> {
  const brief = (await fileBriefs([fileId])).get(fileId)
  if (!brief?.mime.startsWith('image/') || brief.size > IMAGE_BYTES) return null
  try {
    const object = await getObjectStream(brief.storageKey, { bucket: fileBuckets.files() })
    const parts: Buffer[] = []
    for await (const part of object.body) parts.push(Buffer.from(part))
    return `data:${brief.mime};base64,${Buffer.concat(parts).toString('base64')}`
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge', fileId }, 'картинка страницы не вставлена')
    return null
  }
}

/** Названия встроенных объектов — вместо их содержимого в PDF. */
async function titlesOf(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db()
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .where(inArray(objects.id, ids))
  return new Map(rows.map((row) => [row.id, row.title]))
}

function embedIds(blocks: readonly PageBlock[]): string[] {
  const ids: string[] = []
  for (const item of blocks) {
    if (item.kind === 'chart' && item.chartId) ids.push(item.chartId)
    if (item.kind === 'metric' && item.metricId) ids.push(item.metricId)
    if (item.kind === 'dataset' && item.datasetId) ids.push(item.datasetId)
    if (item.kind === 'map' && (item.mapId ?? item.layerId)) {
      ids.push((item.mapId ?? item.layerId) as string)
    }
    if (item.kind === 'tasks' && item.viewId) ids.push(item.viewId)
    if (item.kind === 'file' && item.fileId) ids.push(item.fileId)
  }
  return [...new Set(ids)]
}

async function renderBlock(
  pc: PrintContext,
  item: PageBlock,
  titles: Map<string, string>,
): Promise<Safe> {
  const heading = item.title ? html`<p class="section">${item.title}</p>` : html``
  switch (item.kind) {
    case 'text':
      return html`${heading}${richBody(item.body)}`
    case 'table': {
      const head =
        item.columns.length > 0
          ? html`<thead><tr>${item.columns.map((column) => html`<th>${column}</th>`)}</tr></thead>`
          : html``
      const rows = item.rows.map(
        (row) => html`<tr>${row.map((cell) => html`<td>${multiline(cell)}</td>`)}</tr>`,
      )
      return html`${heading}<table class="grid">${head}<tbody>${rows}</tbody></table>`
    }
    case 'image': {
      const data = item.fileId ? await imageData(item.fileId) : null
      const picture = data ? html`<img src="${data}" style="max-width:100%">` : html``
      const caption = item.caption ? html`<p class="small muted">${item.caption}</p>` : html``
      return html`${heading}<p>${picture}</p>${caption}`
    }
    case 'file': {
      const name = item.fileId ? (titles.get(item.fileId) ?? '') : ''
      return html`${heading}<p class="muted">${pc.t('knowledge.print.file', { name })}</p>`
    }
    default: {
      const id =
        item.kind === 'chart'
          ? item.chartId
          : item.kind === 'metric'
            ? item.metricId
            : item.kind === 'dataset'
              ? item.datasetId
              : item.kind === 'tasks'
                ? item.viewId
                : (item.mapId ?? item.layerId)
      const name = id ? (titles.get(id) ?? '') : ''
      const kind = pc.t(`knowledge.blocks.${item.kind}`)
      return html`${heading}<p class="muted">${pc.t('knowledge.print.embed', { kind, name })}</p>`
    }
  }
}

/** Печатная форма страницы: шапка со сведениями и блоки по порядку. */
async function build(pc: PrintContext, subject: PrintSubject): Promise<PrintBuild> {
  const row = await loadPage(db(), subject.id)
  if (!row) throw new Error('Страница не найдена')
  const titles = await titlesOf(embedIds(row.blocks))
  const body: Safe[] = []
  for (const item of row.blocks) body.push(await renderBlock(pc, item, titles))
  const status = pc.t(`knowledge.status.${row.status}`)
  const version =
    row.versionNumber > 0 ? pc.t('knowledge.print.version', { number: row.versionNumber }) : ''
  return {
    kind: 'html',
    title: row.title,
    body: html`
      <div class="org">${pc.org}</div>
      <h1>${row.title}</h1>
      <p class="subtitle small muted">${[status, version].filter(Boolean).join(' · ')}</p>
      ${body}
    `,
    footer: pc.t('knowledge.print.footer', { title: row.title }),
    fileName: fileNameOf(row.title),
  }
}

/** Форма печати страницы — реестру печатных форм (ADR-0085). */
export function registerPagePrintForm(): void {
  DocumentsPrint.register({
    key: 'page',
    labelKey: 'knowledge.print.form',
    subjectType: 'page',
    build,
  })
}
