import type { BasemapServiceParams } from '@kchs/contracts'

/**
 * Адрес тайла внешней растровой службы (ADR-0108). XYZ подставляет номер тайла
 * в шаблон; WMS и WMTS — запрос службы, который собирает прокси: у WMS это
 * охват тайла в EPSG:3857, у WMTS — номера матрицы, строки и столбца.
 * Ключ доступа подставляется здесь и в браузер не попадает.
 */

/** Половина окружности Земли в проекции 3857, м. */
const ORIGIN = 20_037_508.342_789_244

/** Охват тайла `z/x/y` в EPSG:3857: [minx, miny, maxx, maxy]. */
export function tileBbox(z: number, x: number, y: number): [number, number, number, number] {
  const size = (ORIGIN * 2) / 2 ** z
  const minX = -ORIGIN + x * size
  const maxY = ORIGIN - y * size
  return [minX, maxY - size, minX + size, maxY]
}

const number = (value: number) => value.toFixed(6)

export interface TileTarget {
  kind: 'xyz' | 'wms' | 'wmts'
  url: string
  service: BasemapServiceParams | null
  tileSize: number
}

/** Подстановка ключа доступа: значение экранируется как часть адреса. */
const withKey = (url: string, key: string) => url.replaceAll('{key}', encodeURIComponent(key))

/** Адрес запроса тайла у внешней службы. */
export function serviceTileUrl(
  target: TileTarget,
  z: number,
  x: number,
  y: number,
  key = '',
): string {
  if (target.kind === 'xyz') {
    return withKey(
      target.url
        .replaceAll('{z}', String(z))
        .replaceAll('{x}', String(x))
        .replaceAll('{y}', String(y)),
      key,
    )
  }
  const base = new URL(withKey(target.url, key))
  const params = base.searchParams
  if (target.kind === 'wms') {
    const service = target.service?.kind === 'wms' ? target.service : null
    const version = service?.version ?? '1.3.0'
    const [minX, minY, maxX, maxY] = tileBbox(z, x, y)
    params.set('SERVICE', 'WMS')
    params.set('VERSION', version)
    params.set('REQUEST', 'GetMap')
    params.set('LAYERS', service?.layers ?? '')
    params.set('STYLES', service?.styles ?? '')
    params.set('FORMAT', service?.format ?? 'image/png')
    params.set('TRANSPARENT', service?.transparent === false ? 'FALSE' : 'TRUE')
    params.set('WIDTH', String(target.tileSize))
    params.set('HEIGHT', String(target.tileSize))
    // У 1.3.0 система координат называется CRS, у 1.1.1 — SRS
    params.set(version === '1.3.0' ? 'CRS' : 'SRS', 'EPSG:3857')
    params.set('BBOX', [minX, minY, maxX, maxY].map(number).join(','))
    return base.toString()
  }
  const service = target.service?.kind === 'wmts' ? target.service : null
  params.set('SERVICE', 'WMTS')
  params.set('VERSION', '1.0.0')
  params.set('REQUEST', 'GetTile')
  params.set('LAYER', service?.layer ?? '')
  params.set('STYLE', service?.style ?? 'default')
  params.set('FORMAT', service?.format ?? 'image/png')
  params.set('TILEMATRIXSET', service?.tileMatrixSet ?? 'GoogleMapsCompatible')
  params.set('TILEMATRIX', (service?.tileMatrix ?? '{z}').replaceAll('{z}', String(z)))
  params.set('TILEROW', String(y))
  params.set('TILECOL', String(x))
  return base.toString()
}
