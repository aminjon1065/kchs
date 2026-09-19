/**
 * Минимальный разбор векторного тайла (Mapbox Vector Tile 2.1, protobuf) для
 * тестов: слои, идентификаторы, свойства и тип геометрии объектов. Координаты
 * не декодируются — тесты проверяют, какие строки и поля попали в тайл.
 */

export interface MvtFeature {
  id: number | null
  type: number
  properties: Record<string, unknown>
}

export interface MvtLayer {
  name: string
  extent: number
  features: MvtFeature[]
}

class Reader {
  pos = 0
  constructor(
    private readonly buf: Uint8Array,
    private readonly end = buf.length,
  ) {}

  done(): boolean {
    return this.pos >= this.end
  }

  varint(): number {
    let result = 0
    let multiplier = 1
    for (;;) {
      if (this.pos >= this.end) throw new Error('MVT: varint за концом буфера')
      const byte = this.buf[this.pos++] as number
      result += (byte & 0x7f) * multiplier
      if (byte < 0x80) return result
      multiplier *= 128
    }
  }

  bytes(): Uint8Array {
    const length = this.varint()
    const start = this.pos
    if (start + length > this.end) throw new Error('MVT: поле длиннее буфера')
    this.pos += length
    return this.buf.subarray(start, start + length)
  }

  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 1) this.pos += 8
    else if (wire === 2) {
      // Длину читать отдельно: в `pos += varint()` левая часть берётся до сдвига
      const length = this.varint()
      this.pos += length
    } else if (wire === 5) this.pos += 4
    else throw new Error(`MVT: неизвестный тип поля ${wire}`)
  }
}

function packed(bytes: Uint8Array): number[] {
  const reader = new Reader(bytes)
  const out: number[] = []
  while (!reader.done()) out.push(reader.varint())
  return out
}

function value(bytes: Uint8Array): unknown {
  const reader = new Reader(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let result: unknown = null
  while (!reader.done()) {
    const tag = reader.varint()
    const field = tag >> 3
    const wire = tag & 7
    if (field === 1) result = new TextDecoder().decode(reader.bytes())
    else if (field === 2) {
      result = view.getFloat32(reader.pos, true)
      reader.pos += 4
    } else if (field === 3) {
      result = view.getFloat64(reader.pos, true)
      reader.pos += 8
    } else if (field === 4 || field === 5) result = reader.varint()
    else if (field === 6) {
      const raw = reader.varint()
      result = raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2
    } else if (field === 7) result = reader.varint() === 1
    else reader.skip(wire)
  }
  return result
}

function layer(bytes: Uint8Array): MvtLayer {
  const reader = new Reader(bytes)
  let name = ''
  let extent = 4096
  const keys: string[] = []
  const values: unknown[] = []
  const raw: Array<{ id: number | null; type: number; tags: number[] }> = []
  while (!reader.done()) {
    const tag = reader.varint()
    const field = tag >> 3
    const wire = tag & 7
    if (field === 1) name = new TextDecoder().decode(reader.bytes())
    else if (field === 2) {
      const feature = new Reader(reader.bytes())
      let id: number | null = null
      let type = 0
      let tags: number[] = []
      while (!feature.done()) {
        const featureTag = feature.varint()
        const featureField = featureTag >> 3
        if (featureField === 1) id = feature.varint()
        else if (featureField === 2) tags = packed(feature.bytes())
        else if (featureField === 3) type = feature.varint()
        else feature.skip(featureTag & 7)
      }
      raw.push({ id, type, tags })
    } else if (field === 3) keys.push(new TextDecoder().decode(reader.bytes()))
    else if (field === 4) values.push(value(reader.bytes()))
    else if (field === 5) extent = reader.varint()
    else reader.skip(wire)
  }
  return {
    name,
    extent,
    features: raw.map(({ id, type, tags }) => {
      const properties: Record<string, unknown> = {}
      for (let i = 0; i + 1 < tags.length; i += 2) {
        properties[keys[tags[i] as number] as string] = values[tags[i + 1] as number]
      }
      return { id, type, properties }
    }),
  }
}

export function decodeMvt(buffer: Uint8Array): MvtLayer[] {
  const reader = new Reader(buffer)
  const layers: MvtLayer[] = []
  while (!reader.done()) {
    const tag = reader.varint()
    if (tag >> 3 === 3) layers.push(layer(reader.bytes()))
    else reader.skip(tag & 7)
  }
  return layers
}
