import {
  type ChartFilter,
  type ChartPick,
  type CompiledChart,
  compileChart,
} from '@kchs/chart-spec'
import type { ChartSpec, QueryResult } from '@kchs/contracts'
import type { EChartsType } from 'echarts/core'
import { AlertCircle, BarChart3, Map as MapIcon, Table2 } from 'lucide-react'
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { EmptyState } from '../components/feedback.js'
import { useMediaQuery } from '../hooks/use-media-query.js'
import { useUiLocale, useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { Button } from '../primitives/button.js'
import { ChartTable } from './chart-table.js'
import { useChartTheme } from './chart-theme.js'
import { NumberTile } from './number-tile.js'

type Runtime = typeof import('./echarts-runtime.js')
let runtime: Promise<Runtime> | null = null

/** ECharts грузится один раз и только когда на экране появился график. */
function loadRuntime(): Promise<Runtime> {
  runtime ??= import('./echarts-runtime.js')
  return runtime
}

/** Управление графиком снаружи: картинка для выгрузки «PNG». */
export interface ChartHandle {
  /** PNG кадра ECharts (вдвое плотнее экрана, на фоне карточки); null — у вида нет холста. */
  image: () => Promise<Blob | null>
}

/** Фон под прозрачным кадром: первый непрозрачный фон вверх по дереву. */
function backgroundOf(element: HTMLElement | null): string | null {
  for (let node = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color && color !== 'transparent' && !/,\s*0\)$/.test(color)) return color
  }
  return null
}

async function chartImage(
  instance: EChartsType,
  element: HTMLElement | null,
): Promise<Blob | null> {
  const picture = new Image()
  picture.src = instance.getDataURL({ type: 'png', pixelRatio: 2 })
  await picture.decode()
  const canvas = document.createElement('canvas')
  canvas.width = picture.naturalWidth
  canvas.height = picture.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) return null
  const background = backgroundOf(element)
  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.drawImage(picture, 0, 0)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

export interface ChartProps {
  spec: ChartSpec
  result: QueryResult
  /** Высота области графика, px. */
  height?: number
  /** Идёт перезапрос: остаётся прежний кадр, приглушённый. */
  pending?: boolean
  /** По умолчанию — если пользователь не просил уменьшить движение. */
  animation?: boolean
  /** Пояс платформы для моментов времени. */
  timezone?: string
  /** Полный домен значений поля цвета: цвет закреплён за сущностью. */
  colorDomain?: readonly string[]
  /** Что считается улучшением для дельт показателя. */
  direction?: 'higher_better' | 'lower_better'
  /** Клик по элементу — условия, которые его выбирают (детализация, фильтр). */
  onElementClick?: (pick: ChartPick) => void
  /** Выделение кистью закончено; null — выделение снято. */
  onBrush?: (filter: ChartFilter | null) => void
  /** Картинка кадра для выгрузки (есть только у графиков ECharts). */
  handleRef?: Ref<ChartHandle | null>
  className?: string
}

type EchartsCompiled = Extract<CompiledChart, { kind: 'echarts' }>

interface EChartsViewProps {
  compiled: EchartsCompiled
  height: number
  brushType: 'lineX' | 'lineY' | null
  onElementClick?: (pick: ChartPick) => void
  onBrush?: (filter: ChartFilter | null) => void
  onReadyChange: (ready: boolean) => void
  handleRef?: Ref<ChartHandle | null> | undefined
}

function EChartsView({
  compiled,
  height,
  brushType,
  onElementClick,
  onBrush,
  onReadyChange,
  handleRef,
}: EChartsViewProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [chart, setChart] = useState<EChartsType | null>(null)
  const [ready, setReady] = useState(false)
  // Скелетон — только до первого кадра: перерисовка оставляет прежний кадр на месте
  const [painted, setPainted] = useState(false)
  // Обработчики событий читают актуальные пропсы без переподписки
  const latest = useRef({ compiled, onElementClick, onBrush })
  latest.current = { compiled, onElementClick, onBrush }

  useEffect(() => {
    let disposed = false
    let instance: EChartsType | null = null
    let observer: ResizeObserver | null = null
    const start = async () => {
      // Подписи на canvas рисуются шрифтом интерфейса — ждём его загрузки
      await document.fonts?.ready
      const { init } = await loadRuntime()
      const element = ref.current
      if (disposed || !element) return
      instance = init(element, null, { renderer: 'canvas' })
      instance.on('click', (params) => {
        const pick = latest.current.compiled.pick(params)
        if (pick) latest.current.onElementClick?.(pick)
      })
      // Кисть сообщает диапазон по оси; снятое выделение — пустой список областей
      instance.on('brushEnd', (params) => {
        const areas = (params as { areas?: { coordRange?: unknown }[] }).areas ?? []
        const range = areas[0]?.coordRange
        const bounds =
          Array.isArray(range) && typeof range[0] === 'number' && typeof range[1] === 'number'
            ? { from: range[0], to: range[1] }
            : null
        latest.current.onBrush?.(latest.current.compiled.brush(bounds))
      })
      instance.on('finished', () => {
        setReady(true)
        setPainted(true)
      })
      observer = new ResizeObserver(() => instance?.resize())
      observer.observe(element)
      setChart(instance)
    }
    void start()
    return () => {
      disposed = true
      observer?.disconnect()
      instance?.dispose()
    }
  }, [])

  const option = useMemo(() => {
    // Без обработчика клика элементы не притворяются ссылками
    if (onElementClick) return compiled.option
    const series = compiled.option.series
    return {
      ...compiled.option,
      series: (Array.isArray(series) ? series : series ? [series] : []).map((s) => ({
        ...s,
        cursor: 'default',
      })),
    }
  }, [compiled, onElementClick])

  useEffect(() => {
    if (!chart) return
    setReady(false)
    chart.setOption(option, { notMerge: true })
    if (brushType) {
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType, brushMode: 'single' },
      })
    }
  }, [chart, option, brushType])

  useEffect(() => onReadyChange(ready), [ready, onReadyChange])
  useImperativeHandle(
    handleRef,
    () => ({ image: () => (chart ? chartImage(chart, ref.current) : Promise.resolve(null)) }),
    [chart],
  )

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={ref} role="img" aria-label={compiled.alt} className="absolute inset-0" />
      {painted ? null : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-pulse-soft rounded-md bg-surface-3"
        />
      )}
    </div>
  )
}

/**
 * График по ChartSpec (P1-E06 S01): компиляция `@kchs/chart-spec`, отрисовка
 * ECharts (лениво, canvas), тема — из токенов, пересчёт при смене темы и
 * размера. Описание для экранных дикторов — alt-текст из спецификации; кнопка
 * «Таблица данных» показывает те же значения таблицей. Показатель и таблица —
 * компоненты дизайн-системы без ECharts.
 */
export function Chart({
  spec,
  result,
  height = 280,
  pending = false,
  animation,
  timezone,
  colorDomain,
  direction,
  onElementClick,
  onBrush,
  handleRef,
  className,
}: ChartProps) {
  const t = useUiT()
  const locale = useUiLocale()
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const theme = useChartTheme(host)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const animate = animation ?? !reducedMotion
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const [echartsReady, setEchartsReady] = useState(false)
  const tableId = useId()

  const compiled = useMemo(
    () =>
      theme
        ? compileChart(spec, result, theme, {
            locale,
            timezone,
            colorDomain,
            direction,
            animation: animate,
          })
        : null,
    [spec, result, theme, locale, timezone, colorDomain, direction, animate],
  )

  // Таблица данных — у графиков ECharts и у заглушки карты; показатель читается и так
  const table =
    compiled?.kind === 'echarts' || compiled?.kind === 'unsupported' ? compiled.table : null
  const canToggle = table !== null
  const showTable = canToggle && view === 'table'
  const state = !compiled
    ? 'loading'
    : compiled.kind === 'echarts' && !showTable && !echartsReady
      ? 'loading'
      : 'ready'
  const brushType = spec.options.brush
    ? spec.type === 'bar' && spec.options.horizontal
      ? 'lineY'
      : 'lineX'
    : null

  let body: ReactNode
  if (!compiled) {
    body = (
      <div
        aria-hidden
        className="w-full animate-pulse-soft rounded-md bg-surface-3"
        style={{ height }}
      />
    )
  } else if (showTable && table) {
    body = <ChartTable id={tableId} model={table} maxHeight={height} />
  } else {
    switch (compiled.kind) {
      case 'echarts':
        body = (
          <EChartsView
            compiled={compiled}
            height={height}
            brushType={brushType}
            onElementClick={onElementClick}
            onBrush={onBrush}
            onReadyChange={setEchartsReady}
            handleRef={handleRef}
          />
        )
        break
      case 'number':
        body = <NumberTile model={compiled.model} />
        break
      case 'table':
        body = <ChartTable model={compiled.table} maxHeight={height} />
        break
      case 'empty':
        body = <EmptyState compact icon={<BarChart3 />} title={compiled.message} />
        break
      case 'unsupported':
        body = <EmptyState compact icon={<MapIcon />} title={compiled.message} />
        break
      case 'invalid':
        body = (
          <EmptyState
            compact
            icon={<AlertCircle className="text-danger" />}
            title={compiled.message}
            description={
              <ul className="flex flex-col gap-0.5">
                {compiled.issues.map((issue) => (
                  <li key={`${issue.path.join('.')}:${issue.message}`}>{issue.message}</li>
                ))}
              </ul>
            }
          />
        )
        break
    }
  }

  const notes = compiled && 'meta' in compiled ? compiled.meta.notes : []
  const forced = spec.theme === 'auto' ? undefined : spec.theme

  return (
    <div
      ref={setHost}
      data-theme={forced}
      data-chart-state={state}
      aria-busy={pending || state === 'loading' || undefined}
      className={cn('flex min-w-0 flex-col gap-2', forced && 'bg-surface text-fg', className)}
    >
      {/* Перезапрос: прежний кадр остаётся, приглушённый; подписи и кнопки — нет */}
      <div
        className={cn(
          'min-w-0 transition-opacity duration-[var(--duration-base)]',
          pending && 'opacity-60',
        )}
      >
        {body}
      </div>
      {notes.length > 0 || canToggle ? (
        <div className="flex items-start justify-between gap-3">
          <ul className="flex min-w-0 flex-col gap-0.5 text-xs text-fg-muted">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {canToggle ? (
            <Button
              variant="ghost"
              size="sm"
              // Переключатель вида — экранный: на печати и в отчёте его нет
              className="shrink-0 print:hidden"
              icon={
                showTable ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />
              }
              aria-controls={showTable ? tableId : undefined}
              onClick={() => setView(showTable ? 'chart' : 'table')}
            >
              {showTable ? t('ui.chart.showChart') : t('ui.chart.dataTable')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
