import { cn } from '../lib/cn.js'

export interface HistogramProps {
  /** Высоты столбцов по порядку интервалов. */
  values: number[]
  /** Что показано — для вспомогательных технологий. */
  label: string
  className?: string
}

/**
 * Мини-гистограмма распределения (профиль столбца, подсказки фильтров):
 * столбцы интервалов на общей оси. Полноценные графики — `Chart` (ChartSpec).
 */
export function Histogram({ values, label, className }: HistogramProps) {
  const max = Math.max(0, ...values)
  const width = 100 / Math.max(values.length, 1)
  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn('h-16 w-full text-accent', className)}
    >
      {values.map((value, index) => {
        // Непустой интервал виден даже рядом с очень высоким столбцом
        const height = max > 0 ? Math.max((value / max) * 38, value > 0 ? 1 : 0) : 0
        return (
          <rect
            key={index}
            x={index * width + width * 0.08}
            y={40 - height}
            width={width * 0.84}
            height={height}
            fill="currentColor"
          />
        )
      })}
      <line
        x1="0"
        y1="39.75"
        x2="100"
        y2="39.75"
        stroke="currentColor"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
        className="text-line-strong"
      />
    </svg>
  )
}
