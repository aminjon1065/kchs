/**
 * Модульная сборка ECharts: только типы и компоненты, которые выдаёт
 * `@kchs/chart-spec`, и canvas-рендер. Модуль грузится лениво из `Chart` —
 * отдельный чанк, экраны без графиков его не скачивают.
 */
import {
  BarChart,
  FunnelChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  TreemapChart,
} from 'echarts/charts'
import {
  AriaComponent,
  BrushComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  FunnelChart,
  GaugeChart,
  TreemapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  VisualMapContinuousComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  BrushComponent,
  AriaComponent,
  CanvasRenderer,
])

export { init }
