# Контракт: ChartSpec

```json
{
  "version": 1,
  "type": "line",
  "data": {"queryId": "01J..."} ,
  "encoding": {
    "x": {"field": "month", "type": "temporal", "label": {"ru": "Месяц"}},
    "y": [{"field": "incidents", "type": "quantitative", "label": {"ru": "Происшествия"}, "axis": "left", "format": {"precision": 0}}],
    "color": {"field": "region", "type": "nominal", "palette": "categorical"},
    "size": null, "tooltip": ["region", "incidents", "damage"], "facet": null
  },
  "options": {
    "stacked": false, "smooth": true, "area": false, "points": "auto",
    "legend": {"show": true, "position": "bottom"},
    "axes": {"x": {"grid": false}, "y": {"grid": true, "min": 0, "unit": ""}},
    "referenceLines": [{"axis": "y", "value": 5, "label": "Порог", "style": "dashed", "color": "danger"}],
    "annotations": [{"x": "2026-05-01", "text": "Начало паводка"}],
    "comparison": {"mode": "previous_period"},
    "sort": {"by": "incidents", "dir": "desc"}, "limit": 20, "other": true,
    "labels": {"show": "auto"}, "zoom": true, "brush": true
  },
  "interactions": {"click": {"action": "drill", "target": {"kind": "table"}}, "brush": {"action": "filter"}},
  "theme": "auto"
}
```

## Типы графиков v1
`table`, `number` (показатель: значение, дельта, искра), `bar` (вертикальные/горизонтальные, группировка/стек, `percent`), `line`, `area`, `pie`/`donut` (≤ 8 категорий), `scatter`/`bubble`, `heatmap` (матрица x×y), `histogram`, `funnel`, `gauge`, `pivot`, `map` (ссылка на LayerStyle/карту с данными запроса), `combo` (bar+line, две оси), `treemap`, `sankey` (фаза 3), `boxplot` (фаза 3).

## Кодировки
`x`, `y[]` (несколько серий; `axis: left|right`), `color` (по полю: категориальный/последовательный/расходящийся; или фиксированный), `size`, `shape`, `tooltip[]`, `facet` (малые множители по полю, сетка), `text` (подписи).

Типы каналов: `quantitative`, `temporal`, `nominal`, `ordinal`. Форматирование — из `packages/fields` (единый формат чисел/дат).

## Правила
- Спецификация не содержит цветов в hex, только имена палитр/семантические токены; конкретные цвета берёт тема.
- Компилятор `packages/chart-spec` → ECharts option; тесты снимками для каждого типа в обеих темах.
- Даунсэмплинг: если точек > 5 000 — агрегировать на сервере (шаг `aggregate` с бакетом) или LTTB на клиенте для линий.
- `number` использует показатель (`metricId`) или запрос с одной строкой; сравнение/цель/пороги — из показателя.
- Доступность: alt-текст графика генерируется из спецификации («Линейный график: происшествия по месяцам, 3 региона»), таблица данных доступна по кнопке.
