import { describe, expect, it } from 'vitest'
import { sdfFromMask } from './map-sdf.js'

/** Квадратная маска: непрозрачный квадрат в центре холста. */
function squareMask(size: number, inset: number): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(size * size * 4)
  for (let y = inset; y < size - inset; y++) {
    for (let x = inset; x < size - inset; x++) mask[(y * size + x) * 4 + 3] = 255
  }
  return mask
}

const alphaAt = (data: Uint8ClampedArray, size: number, x: number, y: number) =>
  data[(y * size + x) * 4 + 3] as number

describe('поле расстояний (SDF) для значков карты', () => {
  it('край фигуры — порог 191, внутри больше, снаружи меньше, убывает с расстоянием', () => {
    const size = 32
    const sdf = sdfFromMask(squareMask(size, 8), size, size)
    const center = alphaAt(sdf, size, 16, 16)
    const insideEdge = alphaAt(sdf, size, 8, 16)
    const outsideNear = alphaAt(sdf, size, 6, 16)
    const outsideFar = alphaAt(sdf, size, 1, 16)
    expect(center).toBe(255)
    expect(insideEdge).toBeGreaterThan(191)
    expect(outsideNear).toBeLessThan(191)
    expect(outsideFar).toBeLessThan(outsideNear)
    // Цвет задаёт MapLibre: в RGB поля ничего нет
    expect(sdf[(16 * size + 16) * 4]).toBe(0)
  })

  it('пустая маска — ничего внутри', () => {
    const size = 8
    const sdf = sdfFromMask(new Uint8ClampedArray(size * size * 4), size, size)
    for (let i = 0; i < size * size; i++) expect(sdf[i * 4 + 3]).toBeLessThan(191)
  })
})
