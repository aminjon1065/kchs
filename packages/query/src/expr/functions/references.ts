import { ExpressionError } from '../../errors.js'
import type { Typed } from '../typed.js'
import { type CallArgs, unknownFunction } from './args.js'
import { GeoFunctions } from './geo.js'

export const REFERENCE_FUNCTIONS = [
  'territory_level',
  'territory_name',
  'lookup_label',
  'user_attr',
] as const

/** Слой 3г: справочники и атрибуты пользователя. */
export abstract class ReferenceFunctions extends GeoFunctions {
  protected referenceCall(c: CallArgs): Typed {
    const { name, args, span, pos, arity, arg } = c
    switch (name) {
      // ── справочники и пользователь
      case 'territory_level': {
        arity(2)
        const key = this.territoryKey(arg(0), name)
        const level = this.levelLiteral(arg(1))
        const map = this.reference({ kind: 'territory_level', level, key }, pos)
        if (key === 'code') {
          return this.make('text', args, span, () => `(${map} ->> ${arg(0).emit('text')})`)
        }
        // Предок — тоже территория: подписи и фильтры работают с ним, как с полем
        return {
          ...this.make(
            'uuid',
            args,
            span,
            () =>
              `(${this.d.cast(`(${map} ->> ${this.d.cast(`(${arg(0).emit('uuid')})`, 'text')})`, 'uuid')})`,
          ),
          fieldType: 'territory',
        }
      }
      case 'territory_name': {
        arity(1)
        const key = this.territoryKey(arg(0), name)
        const map = this.reference({ kind: 'territory_name', key }, pos)
        const value = () =>
          key === 'code' ? arg(0).emit('text') : this.d.cast(`(${arg(0).emit('uuid')})`, 'text')
        return this.make('text', args, span, () => `(${map} ->> ${value()})`)
      }
      case 'lookup_label': {
        arity(1)
        const field = arg(0)
        if (!field.lookup) {
          throw new ExpressionError(
            'lookup_label() принимает поле, связанное со справочником',
            field.pos,
            'Связь поля со справочником задаётся на вкладке «Схема» датасета',
          )
        }
        const map = this.reference({ kind: 'lookup_label', ...field.lookup }, pos)
        return this.make(
          'text',
          args,
          span,
          () => `(${map} ->> ${this.d.cast(`(${field.emit()})`, 'text')})`,
        )
      }
      case 'user_attr': {
        arity(1)
        const key = arg(0)
        if (key.literal?.kind !== 'string') {
          throw new ExpressionError(
            'Имя атрибута пишется строкой',
            key.pos,
            "Например, user_attr('territory_codes')",
          )
        }
        return this.value(
          this.env.userAttr(key.literal.value as string, key.pos),
          span,
          `user_attr('${key.literal.value}')`,
        )
      }
      default:
        throw unknownFunction(name, pos)
    }
  }
}
