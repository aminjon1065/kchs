/**
 * Проверка и очистка JPEG фото сводки (ADR-0208). Устройство уже пережало снимок
 * через canvas и метаданных в нём нет, но сервер не верит клиенту: из файла
 * выбрасываются блоки приложений APP1–APP15 (EXIF с координатами съёмки и моделью
 * телефона, XMP, ICC, IPTC) и комментарии, остаются JFIF и сами данные изображения.
 * Пиксели не декодируются — картинку рисует браузер, а превью строит движок.
 */

export interface CleanJpeg {
  bytes: Buffer
  width: number
  height: number
}

/** Сторона снимка больше этой — не фото с телефона, а попытка уронить просмотрщик. */
const MAX_SIDE = 8192

/** Маркеры без длины: SOI, EOI, RST0–RST7, TEM. */
const standalone = (marker: number) =>
  marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)

/** Начало кадра (SOF0–SOF15, кроме DHT, JPG и DAC): в нём высота и ширина. */
const frameStart = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

/** Блоки, которые выбрасываются: APP1–APP15 и COM. */
const dropped = (marker: number) => (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe

export class JpegError extends Error {}

export function cleanJpeg(input: Buffer): CleanJpeg {
  if (input.byteLength < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new JpegError('Не JPEG')
  }
  const parts: Buffer[] = [input.subarray(0, 2)]
  let offset = 2
  let width = 0
  let height = 0
  while (offset < input.byteLength) {
    if (input[offset] !== 0xff) throw new JpegError('Повреждённая структура JPEG')
    // Заполняющие байты 0xFF перед маркером
    let cursor = offset + 1
    while (cursor < input.byteLength && input[cursor] === 0xff) cursor += 1
    const marker = input[cursor]
    if (marker === undefined) throw new JpegError('JPEG оборван')
    if (standalone(marker)) {
      if (marker === 0xd9) {
        parts.push(input.subarray(offset, cursor + 1))
        break
      }
      parts.push(input.subarray(offset, cursor + 1))
      offset = cursor + 1
      continue
    }
    if (cursor + 3 > input.byteLength) throw new JpegError('JPEG оборван')
    const length = input.readUInt16BE(cursor + 1)
    const end = cursor + 1 + length
    if (length < 2 || end > input.byteLength) throw new JpegError('JPEG оборван')
    if (frameStart(marker)) {
      if (length < 7) throw new JpegError('Повреждённый заголовок кадра JPEG')
      height = input.readUInt16BE(cursor + 4)
      width = input.readUInt16BE(cursor + 6)
    }
    if (marker === 0xda) {
      // Начало скана: дальше — сжатые данные до конца файла, они копируются как есть
      if (!width || !height) throw new JpegError('JPEG без заголовка кадра')
      parts.push(input.subarray(offset))
      offset = input.byteLength
      break
    }
    if (!dropped(marker)) parts.push(input.subarray(offset, end))
    offset = end
  }
  if (!width || !height) throw new JpegError('JPEG без изображения')
  if (width > MAX_SIDE || height > MAX_SIDE) throw new JpegError('Слишком большой снимок')
  return { bytes: Buffer.concat(parts), width, height }
}
