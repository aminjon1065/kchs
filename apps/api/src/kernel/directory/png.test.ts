import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { sanitizePng } from './png.js'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.byteLength, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** PNG RGBA заданного размера и посторонние блоки перед данными. */
function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x40)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('факсимиле: проверка и пересборка PNG (ADR-0198)', () => {
  it('оставляет только блоки изображения', () => {
    const secret = chunk('tEXt', Buffer.from('Comment\u0000вложенные данные', 'utf8'))
    const time = chunk('tIME', Buffer.alloc(7))
    const input = png(300, 120, [secret, time])
    const result = sanitizePng(input)
    expect(result).toMatchObject({ width: 300, height: 120 })
    expect(result.png.includes(Buffer.from('tEXt', 'latin1'))).toBe(false)
    expect(result.png.includes(Buffer.from('tIME', 'latin1'))).toBe(false)
    expect(result.png.byteLength).toBeLessThan(input.byteLength)
    // Пересобранный файл — снова правильный PNG
    expect(sanitizePng(result.png).png.equals(result.png)).toBe(true)
  })

  it('отказывает файлу не PNG, битому блоку и обрезанному файлу', () => {
    expect(() => sanitizePng(Buffer.from('GIF89a……'))).toThrow(/не PNG/)
    const broken = png(100, 50)
    const at = broken.length - 20
    broken.writeUInt8(broken.readUInt8(at) ^ 0xff, at)
    expect(() => sanitizePng(broken)).toThrow(/контрольная сумма|битый/)
    expect(() => sanitizePng(png(100, 50).subarray(0, 40))).toThrow()
  })

  it('держит пределы размеров', () => {
    expect(() => sanitizePng(png(1300, 100))).toThrow(/1200×600/)
    expect(() => sanitizePng(png(10, 10))).toThrow(/мала/)
  })
})
