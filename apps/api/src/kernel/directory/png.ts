import { crc32 } from 'node:zlib'
import { FACSIMILE_MAX_BYTES, FACSIMILE_MAX_HEIGHT, FACSIMILE_MAX_WIDTH } from '@kchs/contracts'
import { errors } from '~/shared/errors.js'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/**
 * Блоки, без которых картинки нет: заголовок, палитра, прозрачность, данные, конец.
 * Всё остальное — текст, профили, время, анимация, частные блоки — выбрасывается.
 */
const KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])
const MIN_WIDTH = 32
const MIN_HEIGHT = 16

/**
 * Проверка и пересборка PNG факсимиле (ADR-0198): сигнатура, длины и CRC блоков,
 * заголовок, размеры; в результате остаются только блоки изображения. Пиксели
 * не декодируются — картинку рисует Chromium движка в песочнице без сети.
 */
export function sanitizePng(input: Buffer): { png: Buffer; width: number; height: number } {
  const invalid = (message: string) =>
    errors.validation(`Факсимиле: ${message}`, [{ path: 'png', message: 'invalid_png' }])
  if (input.byteLength > FACSIMILE_MAX_BYTES) throw invalid('файл больше 256 КБ')
  if (input.byteLength < SIGNATURE.byteLength || !input.subarray(0, 8).equals(SIGNATURE)) {
    throw invalid('это не PNG')
  }
  const kept: Buffer[] = [SIGNATURE]
  let offset = 8
  let width = 0
  let height = 0
  let sawData = false
  let ended = false
  let first = true
  while (offset < input.byteLength) {
    if (offset + 12 > input.byteLength) throw invalid('файл обрезан')
    const length = input.readUInt32BE(offset)
    const type = input.toString('latin1', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (!/^[A-Za-z]{4}$/.test(type) || end > input.byteLength) throw invalid('битый блок')
    const crc = input.readUInt32BE(offset + 8 + length)
    if (crc32(input.subarray(offset + 4, offset + 8 + length)) !== crc) {
      throw invalid('контрольная сумма блока не сходится')
    }
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw invalid('нет заголовка')
      width = input.readUInt32BE(offset + 8)
      height = input.readUInt32BE(offset + 12)
      const compression = input[offset + 18]
      const filter = input[offset + 19]
      const interlace = input[offset + 20]
      if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
        throw invalid('неизвестный формат сжатия')
      }
      first = false
    }
    if (type === 'IDAT') sawData = true
    if (KEEP.has(type)) kept.push(input.subarray(offset, end))
    offset = end
    if (type === 'IEND') {
      ended = true
      break
    }
  }
  if (!sawData || !ended) throw invalid('нет данных изображения')
  if (width < MIN_WIDTH || height < MIN_HEIGHT) throw invalid('картинка слишком мала')
  if (width > FACSIMILE_MAX_WIDTH || height > FACSIMILE_MAX_HEIGHT) {
    throw invalid(`картинка больше ${FACSIMILE_MAX_WIDTH}×${FACSIMILE_MAX_HEIGHT} пикселей`)
  }
  return { png: Buffer.concat(kept), width, height }
}
