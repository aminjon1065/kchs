import type { LayerGeometryType, LayerStyle } from '@kchs/contracts'
import { LayerStyle as LayerStyleSchema } from '@kchs/contracts'

/** Стиль по умолчанию: простой, по типу геометрии; точки — с кластерами. */
export function defaultStyle(geometryType: LayerGeometryType): LayerStyle {
  const geometry = geometryType === 'mixed' ? 'point' : geometryType
  return LayerStyleSchema.parse({
    version: 1,
    geometry,
    renderer: { kind: 'simple', color: 'categorical.1' },
    cluster: geometry === 'point' ? { enabled: true } : null,
  })
}
