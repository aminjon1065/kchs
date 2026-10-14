import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { baseName, planImport, sha256Hex } from './import-plan.js'

/** Документы из выгрузки госЭДО (ADR-0219): основной файл, приложения, архивы. */
const file = (name: string, content = name, type = '') => new File([content], name, { type })

describe('документы из файлов госЭДО', () => {
  it('каждый файл — отдельный документ, тема — по имени файла', async () => {
    const plan = await planImport([file('Письмо 1.pdf'), file('Письмо 2.docx')], 'separate')
    expect(plan.map((item) => [item.name, item.main.name, item.attachments.length])).toEqual([
      ['Письмо 1', 'Письмо 1.pdf', 0],
      ['Письмо 2', 'Письмо 2.docx', 0],
    ])
  })

  it('один документ: основной — PDF, остальное — приложения', async () => {
    const plan = await planImport(
      [file('смета.xlsx'), file('подпись.sig'), file('Письмо Минфина.pdf')],
      'single',
    )
    expect(plan).toHaveLength(1)
    expect(plan[0]?.name).toBe('Письмо Минфина')
    expect(plan[0]?.main.name).toBe('Письмо Минфина.pdf')
    expect(plan[0]?.attachments.map((item) => item.name)).toEqual(['смета.xlsx', 'подпись.sig'])
  })

  it('ZIP — один документ с приложениями; служебные файлы архива пропускаются', async () => {
    const archive = zipSync({
      'doc/приложение.docx': new TextEncoder().encode('docx'),
      'doc/письмо.pdf': new TextEncoder().encode('%PDF'),
      '__MACOSX/doc/._письмо.pdf': new TextEncoder().encode('x'),
      'doc/.DS_Store': new TextEncoder().encode('x'),
    })
    const zip = new File([archive as BlobPart], 'Выгрузка 77.zip', { type: 'application/zip' })
    const plan = await planImport([zip, file('отдельно.pdf')], 'separate')
    expect(plan.map((item) => item.name)).toEqual(['Выгрузка 77', 'отдельно'])
    expect(plan[0]?.main.name).toBe('письмо.pdf')
    expect(plan[0]?.main.type).toBe('application/pdf')
    expect(plan[0]?.attachments.map((item) => item.name)).toEqual(['приложение.docx'])
  })

  it('SHA-256 и имя без расширения', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(baseName('Письмо.Минфина.pdf')).toBe('Письмо.Минфина')
  })
})
