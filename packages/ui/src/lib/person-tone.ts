/**
 * Цвет человека — один из оттенков палитры графиков (chart-1…8 без 4 и 7:
 * жёлтый и фиолетовый хуже различимы подложкой и курсором). Один и тот же у
 * аватара и у курсора соавтора: выбирается по имени.
 */
export const PERSON_TONES = [1, 2, 3, 5, 6, 8] as const
export type PersonTone = (typeof PERSON_TONES)[number]

export function personTone(name: string): PersonTone {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return PERSON_TONES[hash % PERSON_TONES.length] ?? 1
}
