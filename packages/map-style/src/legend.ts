/**
 * Знаков после запятой, чтобы подписи классов различались и не теряли больше 1 %
 * значения: 12,3 вместо 12, но 1 235 вместо 1 234,5. Не больше шести.
 */
export function autoPrecision(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  const distinct = new Set(finite).size
  for (let p = 0; p < 6; p += 1) {
    const rounded = finite.map((v) => Number(v.toFixed(p)))
    const precise = finite.every((v, i) => Math.abs(rounded[i]! - v) <= Math.abs(v) * 0.01)
    if (precise && new Set(rounded).size === distinct) return p
  }
  return 6
}

/** Знаков у числа без нулей в конце: 18,0 при точности 1 — «18», 2,40 при 2 — «2,4». */
export function trimmedPrecision(value: number, precision: number): number {
  const target = Number(value.toFixed(precision))
  let digits = 0
  while (digits < precision && Number(value.toFixed(digits)) !== target) digits += 1
  return digits
}
