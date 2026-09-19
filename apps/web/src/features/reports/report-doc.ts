import {
  DEFAULT_REPORT_SETTINGS,
  REPORT_BLOCK_LAYOUT,
  REPORT_DOC,
  ReportBlock,
  type ReportBlockKind,
  ReportSettings,
} from '@kchs/contracts'
import * as Y from 'yjs'
import { type CellMap, newCellId } from '~/features/notebooks/notebook-doc.js'

/**
 * Документ Yjs отчёта на клиенте (ADR-0078): корневые типы и ключи — как у
 * тетради, поэтому порядок, перенос, удаление и копирование блоков — функции
 * `notebook-doc`; здесь — создание блока по раскладке отчёта и настройки печати.
 */

export const settingsOf = (doc: Y.Doc) => doc.getMap<unknown>(REPORT_DOC.settings)

/** Новый блок вида: значения по умолчанию — из контракта. */
export function createBlock(
  kind: ReportBlockKind,
  init: Record<string, unknown> = {},
): { id: string; map: CellMap } {
  const id = newCellId()
  const values = ReportBlock.parse({ ...init, id, kind }) as unknown as Record<string, unknown>
  const map = new Y.Map<unknown>()
  for (const [key, valueKind] of Object.entries(REPORT_BLOCK_LAYOUT[kind])) {
    const value = values[key]
    if (valueKind === 'rich') map.set(key, new Y.XmlFragment())
    else if (valueKind === 'text') map.set(key, new Y.Text(typeof value === 'string' ? value : ''))
    else if (value !== undefined) map.set(key, value)
  }
  return { id, map }
}

/** Настройки печати: значение вне контракта — по умолчанию. */
export function readSettings(doc: Y.Doc): ReportSettings {
  const map = settingsOf(doc)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_REPORT_SETTINGS) as Array<keyof ReportSettings>) {
    const field = ReportSettings.shape[key].safeParse(map.get(key))
    out[key] = field.success ? field.data : DEFAULT_REPORT_SETTINGS[key]
  }
  return out as ReportSettings
}

/** Правка настроек одной транзакцией: соавторы получают её целиком. */
export function writeSettings(doc: Y.Doc, patch: Partial<ReportSettings>): void {
  doc.transact(() => {
    const map = settingsOf(doc)
    for (const [key, value] of Object.entries(patch)) map.set(key, value)
  })
}
