import type { Typed } from '../typed.js'
import { type CallArgs, unknownFunction } from './args.js'
import { DateFunctions } from './dates.js'

export const GEO_FUNCTIONS = [
  'st_distance',
  'st_within',
  'st_intersects',
  'st_area',
  'st_length',
  'st_buffer',
  'st_centroid',
  'st_x',
  'st_y',
  'st_point',
] as const

/** Слой 3в: функции геометрии. */
export abstract class GeoFunctions extends DateFunctions {
  protected geoCall(c: CallArgs): Typed {
    const { name, args, span, pos, arity, arg, num, geom } = c
    switch (name) {
      // ── гео
      case 'st_distance': {
        arity(2)
        geom(0)
        geom(1)
        return this.make(
          'number',
          args,
          span,
          () =>
            `ST_Distance(${this.d.geography(arg(0).emit('geometry'))}, ${this.d.geography(arg(1).emit('geometry'))})`,
        )
      }
      case 'st_within':
      case 'st_intersects': {
        arity(2)
        geom(0)
        geom(1)
        const fn = name === 'st_within' ? 'ST_Within' : 'ST_Intersects'
        return this.make(
          'boolean',
          args,
          span,
          () => `${fn}(${arg(0).emit('geometry')}, ${arg(1).emit('geometry')})`,
        )
      }
      case 'st_area':
        arity(1)
        geom(0)
        return this.make(
          'number',
          args,
          span,
          () => `(ST_Area(${this.d.geography(arg(0).emit('geometry'))}) / 1000000.0)`,
        )
      case 'st_length':
        arity(1)
        geom(0)
        return this.make(
          'number',
          args,
          span,
          () => `(ST_Length(${this.d.geography(arg(0).emit('geometry'))}) / 1000.0)`,
        )
      case 'st_buffer':
        arity(2)
        geom(0)
        num(1)
        return this.make(
          'geometry',
          args,
          span,
          () =>
            `ST_Buffer(${this.d.geography(arg(0).emit('geometry'))}, ${arg(1).emit('number')})::geometry`,
        )
      case 'st_centroid':
        arity(1)
        geom(0)
        return this.make('geometry', args, span, () => `ST_Centroid(${arg(0).emit('geometry')})`)
      case 'st_x':
      case 'st_y':
        arity(1)
        geom(0)
        return this.make(
          'number',
          args,
          span,
          () => `${name === 'st_x' ? 'ST_X' : 'ST_Y'}(${arg(0).emit('geometry')})`,
        )
      case 'st_point':
        arity(2)
        num(0)
        num(1)
        return this.make(
          'geometry',
          args,
          span,
          () =>
            `ST_SetSRID(ST_MakePoint(${arg(0).emit('number')}, ${arg(1).emit('number')}), 4326)`,
        )
      default:
        throw unknownFunction(name, pos)
    }
  }
}
