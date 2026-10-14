import { ExpressionError } from '../../errors.js'
import type { Typed } from '../typed.js'

/** Разобранный вызов функции выражения: имя, аргументы, место и проверки аргументов. */
export interface CallArgs {
  name: string
  args: Typed[]
  span: { pos: number; end: number }
  pos: number
  arity: (min: number, max?: number) => void
  arg: (index: number) => Typed
  num: (index: number) => Typed
  text: (index: number) => Typed
  geom: (index: number) => Typed
}

/** «Неизвестная функция» — одна ошибка у раздачи по группам и у самих групп. */
export function unknownFunction(name: string, pos: number): never {
  throw new ExpressionError(`Неизвестная функция ${name}()`, pos, 'Проверьте имя функции')
}
