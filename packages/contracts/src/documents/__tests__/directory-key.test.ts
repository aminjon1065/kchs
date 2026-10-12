import { describe, expect, it } from 'vitest'
import { DirectoryKey, keyFromName } from '../directory-key.js'

describe('ключ справочника (ADR-0206)', () => {
  it('транслитерирует русские и таджикские названия', () => {
    expect(keyFromName('Обращения граждан')).toBe('obrashcheniya_grazhdan')
    expect(keyFromName('Журнал ЧС № 1')).toBe('zhurnal_chs_1')
    expect(keyFromName('Ҳуҷҷатҳои воридотӣ')).toBe('hujjathoi_voridoti')
    expect(keyFromName('Қарорҳо ва ғайра')).toBe('qarorho_va_ghayra')
  })

  it('ключ всегда проходит проверку контракта', () => {
    for (const name of ['2026 — приказы', '№', '   ', 'Very Long '.repeat(20)]) {
      const key = keyFromName(name, 'journal')
      expect(DirectoryKey.safeParse(key).success, key).toBe(true)
    }
    expect(keyFromName('2026 — приказы')).toBe('j_2026_prikazy')
    expect(keyFromName('№', 'journal')).toBe('journal')
  })

  it('неверный ключ отклоняется', () => {
    expect(DirectoryKey.safeParse('Входящие').success).toBe(false)
    expect(DirectoryKey.safeParse('1abc').success).toBe(false)
    expect(DirectoryKey.safeParse('a').success).toBe(false)
    expect(DirectoryKey.safeParse('incoming_2').success).toBe(true)
  })
})
