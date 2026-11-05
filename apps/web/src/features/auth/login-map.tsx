import type { Locale } from '@kchs/i18n'
import { cn } from '@kchs/ui'
import { useT } from '~/shared/i18n.js'
import { LOGIN_MAP } from './login-map-data.js'

/**
 * Стилизованная карта экрана входа (ADR-0230): контуры районов из сида территорий и
 * подписи трёх городов. Своя геометрия, без тайлов и внешних запросов — страница входа
 * работает и без подложки (CSP). Цвета — токены тёмной поверхности рейла.
 */
export function LoginMap({ locale }: { locale: Locale }) {
  const t = useT()
  const { width, height, districts, cities } = LOGIN_MAP

  return (
    <figure className="relative m-0 w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('auth.signIn.mapLabel')}
        className="block h-auto w-full"
      >
        <path
          d={districts}
          className="fill-rail-active stroke-rail-fg/40"
          strokeWidth={0.8}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {cities.map((city) => (
        <span
          key={city.code}
          className="absolute flex -translate-x-1 -translate-y-1/2 items-center gap-2"
          style={{ left: `${(city.x / width) * 100}%`, top: `${(city.y / height) * 100}%` }}
        >
          <span
            aria-hidden
            className={cn(
              'shrink-0 rounded-full',
              city.capital
                ? 'size-2.5 bg-rail-fg-active ring-4 ring-rail-indicator/40'
                : 'size-2 bg-rail-fg',
            )}
          />
          <span
            className={cn(
              'font-mono text-xs uppercase tracking-widest',
              city.capital ? 'text-rail-fg-active' : 'text-rail-fg',
            )}
          >
            {city.name[locale]}
          </span>
        </span>
      ))}
    </figure>
  )
}

/** Координаты столицы для строки над картой: «38,56° с. ш. · 68,78° в. д.». */
export function capitalCoordinates(locale: Locale): { lat: string; lon: string } | null {
  const capital = LOGIN_MAP.cities.find((city) => city.capital)
  if (!capital) return null
  const format = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return { lat: format.format(capital.lat), lon: format.format(capital.lon) }
}
