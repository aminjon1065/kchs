import { describe, expect, it } from 'vitest'
import { cleanJpeg, JpegError } from './jpeg.js'

const segment = (marker: number, data: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(data.byteLength + 2, 2)
  return Buffer.concat([head, data])
}

const frame = (width: number, height: number) => {
  const data = Buffer.alloc(6)
  data[0] = 8
  data.writeUInt16BE(height, 1)
  data.writeUInt16BE(width, 3)
  data[5] = 1
  return segment(0xc0, data)
}

/** JPEG по структуре: JFIF, EXIF с координатами, комментарий, кадр, скан. */
function sample(width = 1600, height = 1200): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01', 'latin1')),
    segment(0xe1, Buffer.from('Exif\0\0GPS 38.55 68.78', 'latin1')),
    segment(0xfe, Buffer.from('камера Ивана', 'utf8')),
    segment(0xdb, Buffer.alloc(65, 1)),
    frame(width, height),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ])
}

describe('очистка JPEG фото сводки', () => {
  it('выбрасывает EXIF и комментарий, оставляет JFIF, таблицы, кадр и скан', () => {
    const input = sample()
    const clean = cleanJpeg(input)
    expect(clean).toMatchObject({ width: 1600, height: 1200 })
    expect(clean.bytes.includes(Buffer.from('GPS'))).toBe(false)
    expect(clean.bytes.includes(Buffer.from('камера', 'utf8'))).toBe(false)
    expect(clean.bytes.includes(Buffer.from('JFIF'))).toBe(true)
    // Сжатые данные после скана — байт в байт
    const tail = input.subarray(input.indexOf(Buffer.from([0xff, 0xda])))
    expect(clean.bytes.subarray(clean.bytes.byteLength - tail.byteLength).equals(tail)).toBe(true)
  })

  it('не JPEG, оборванный файл и снимок без кадра — отказ', () => {
    expect(() => cleanJpeg(Buffer.from('GIF89a-ничего'))).toThrow(JpegError)
    expect(() => cleanJpeg(sample().subarray(0, 30))).toThrow(JpegError)
    const noFrame = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
      Buffer.from([0xff, 0xd9]),
    ])
    expect(() => cleanJpeg(noFrame)).toThrow(JpegError)
  })

  it('сторона больше 8192 пикселей — отказ', () => {
    expect(() => cleanJpeg(sample(20_000, 100))).toThrow('Слишком большой снимок')
  })
})
