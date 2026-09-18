import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { crc32, createDeflateRaw } from 'node:zlib'

const LOCAL_HEADER = 0x04034b50
const DATA_DESCRIPTOR = 0x08074b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
/** Бит 3 — CRC и размеры в дескрипторе после данных, бит 11 — имена в UTF-8. */
const FLAGS = 0x0008 | 0x0800
const DEFLATE = 8
const VERSION = 20
const MAX_32 = 0xffffffff

interface Entry {
  name: Buffer
  crc: number
  compressed: number
  size: number
  offset: number
}

function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Потоковая запись ZIP — ровно столько, сколько нужно XLSX: записи идут по
 * очереди и сжимаются deflate по мере поступления, CRC и размеры — в
 * дескрипторе после данных. ZIP64 нет: больше 4 ГБ — ошибка (экспорт
 * ограничен миллионом строк).
 */
export class ZipWriter {
  private offset = 0
  private readonly entries: Entry[] = []
  private readonly stamp = dosStamp(new Date())

  constructor(private readonly out: Writable) {}

  private async write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length
    if (!this.out.write(chunk)) await once(this.out, 'drain')
  }

  /** Запись архива из источника строк или буферов (строки — в UTF-8). */
  async add(
    name: string,
    source: AsyncIterable<string | Buffer> | Iterable<string | Buffer>,
  ): Promise<void> {
    const nameBytes = Buffer.from(name, 'utf8')
    const offset = this.offset
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER, 0)
    header.writeUInt16LE(VERSION, 4)
    header.writeUInt16LE(FLAGS, 6)
    header.writeUInt16LE(DEFLATE, 8)
    header.writeUInt16LE(this.stamp.time, 10)
    header.writeUInt16LE(this.stamp.date, 12)
    // CRC и размеры (14–25) остаются нулями: они в дескрипторе после данных
    header.writeUInt16LE(nameBytes.length, 26)
    await this.write(Buffer.concat([header, nameBytes]))

    let crc = 0
    let size = 0
    let compressed = 0
    const deflate = createDeflateRaw()
    const pump = (async () => {
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        compressed += chunk.length
        await this.write(chunk)
      }
    })()
    try {
      for await (const piece of source) {
        const bytes = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece
        if (bytes.length === 0) continue
        crc = crc32(bytes, crc)
        size += bytes.length
        if (!deflate.write(bytes)) await once(deflate, 'drain')
      }
      deflate.end()
    } catch (error) {
      deflate.destroy()
      await pump.catch(() => undefined)
      throw error
    }
    await pump
    if (size > MAX_32 || this.offset > MAX_32) {
      throw new Error('Файл больше 4 ГБ — такой архив без ZIP64 не записать')
    }

    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeUInt32LE(compressed, 8)
    descriptor.writeUInt32LE(size, 12)
    await this.write(descriptor)
    this.entries.push({ name: nameBytes, crc, compressed, size, offset })
  }

  /** Центральный каталог и конец архива; поток вывода закрывает вызывающий. */
  async close(): Promise<void> {
    const start = this.offset
    for (const entry of this.entries) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(CENTRAL_HEADER, 0)
      header.writeUInt16LE(VERSION, 4)
      header.writeUInt16LE(VERSION, 6)
      header.writeUInt16LE(FLAGS, 8)
      header.writeUInt16LE(DEFLATE, 10)
      header.writeUInt16LE(this.stamp.time, 12)
      header.writeUInt16LE(this.stamp.date, 14)
      header.writeUInt32LE(entry.crc, 16)
      header.writeUInt32LE(entry.compressed, 20)
      header.writeUInt32LE(entry.size, 24)
      header.writeUInt16LE(entry.name.length, 28)
      // Длины доп. поля и комментария, диск, атрибуты (30–41) — нули
      header.writeUInt32LE(entry.offset, 42)
      await this.write(Buffer.concat([header, entry.name]))
    }
    const size = this.offset - start
    if (start > MAX_32) throw new Error('Файл больше 4 ГБ — такой архив без ZIP64 не записать')
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_CENTRAL, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(start, 16)
    await this.write(end)
  }
}
