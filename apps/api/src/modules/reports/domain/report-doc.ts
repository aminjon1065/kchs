import {
  DEFAULT_REPORT_SETTINGS,
  REPORT_BLOCK_LAYOUT,
  REPORT_DOC,
  REPORT_MAX_BLOCKS,
  ReportBlock,
  type ReportBlockKind,
  type ReportParams,
  NotebookPeriod as ReportPeriod,
  ReportSettings,
  WithinValue,
} from '@kchs/contracts'
import * as Y from 'yjs'
import { type BlockDocDefinition, insertBlocks, readBlocks } from '~/kernel/collab/block-doc.js'

/**
 * Документ Yjs отчёта ↔ JSON (ADR-0078): раскладка — в контракте
 * `REPORT_BLOCK_LAYOUT`, как у тетради (ADR-0071). Документ пишут клиенты:
 * блок, не прошедший контракт, в снимок не попадает, настройки и параметры —
 * значения по умолчанию.
 */

/** Клиент Yjs начального состояния — один у всех процессов (как у тетради). */
const INITIAL_CLIENT_ID = 1

export interface ReportBody {
  blocks: ReportBlock[]
  params: ReportParams
  settings: ReportSettings
}

const BLOCKS: BlockDocDefinition = {
  blocks: REPORT_DOC.blocks,
  order: REPORT_DOC.order,
  layoutOf: (kind) =>
    typeof kind === 'string' && kind in REPORT_BLOCK_LAYOUT
      ? REPORT_BLOCK_LAYOUT[kind as ReportBlockKind]
      : null,
  max: REPORT_MAX_BLOCKS,
}

/** Блоки — в документ на позицию `index` (по умолчанию в конец). */
export function insertReportBlocks(doc: Y.Doc, blocks: ReportBlock[], index?: number): void {
  insertBlocks(doc, BLOCKS, blocks, index)
}

function writeSettings(doc: Y.Doc, settings: ReportSettings): void {
  const map = doc.getMap<unknown>(REPORT_DOC.settings)
  for (const [key, value] of Object.entries(settings)) map.set(key, value)
}

/** Начальное состояние документа из JSON — детерминированное. */
export function reportState(body: ReportBody): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = INITIAL_CLIENT_ID
  doc.transact(() => {
    insertReportBlocks(doc, body.blocks)
    const params = doc.getMap<unknown>(REPORT_DOC.params)
    params.set('period', body.params.period)
    params.set('territory', body.params.territory)
    writeSettings(doc, body.settings)
  })
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

/** Настройки печати из документа: значение, не прошедшее контракт, — по умолчанию. */
function readSettings(doc: Y.Doc): ReportSettings {
  const map = doc.getMap<unknown>(REPORT_DOC.settings)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_REPORT_SETTINGS) as Array<keyof ReportSettings>) {
    const field = ReportSettings.shape[key].safeParse(map.get(key))
    out[key] = field.success ? field.data : DEFAULT_REPORT_SETTINGS[key]
  }
  return out as ReportSettings
}

/** Снимок документа: блоки по порядку, параметры, настройки печати. */
export function readReport(doc: Y.Doc): ReportBody {
  const blocks = readBlocks(doc, BLOCKS, (raw) => {
    const parsed = ReportBlock.safeParse(raw)
    return parsed.success ? parsed.data : null
  })
  const params = doc.getMap<unknown>(REPORT_DOC.params)
  const period = ReportPeriod.nullable().safeParse(params.get('period') ?? null)
  const territory = WithinValue.nullable().safeParse(params.get('territory') ?? null)
  return {
    blocks,
    params: {
      period: period.success ? period.data : null,
      territory: territory.success ? territory.data : null,
    },
    settings: readSettings(doc),
  }
}
