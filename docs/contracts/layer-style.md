# Контракт: LayerStyle

```json
{
  "version": 1,
  "geometry": "point",
  "renderer": {
    "kind": "graduated",
    "field": "population",
    "method": "quantile", "classes": 5, "breaks": null,
    "palette": {"name": "blue", "reverse": false},
    "normalizeBy": "area_km2",
    "visual": {"target": "fill"}
  },
  "point": {"shape": "circle", "size": 8, "icon": null, "sizeBy": {"field": "capacity", "min": 4, "max": 24, "scale": "sqrt"}},
  "line": {"width": 2, "dash": null, "cap": "round"},
  "polygon": {"fillOpacity": 0.6, "outline": {"width": 1, "color": "auto"}},
  "heatmap": null,
  "cluster": {"enabled": true, "radius": 40, "maxZoom": 11, "style": {"sizeBy": "point_count", "min": 16, "max": 48}},
  "label": {"field": "name", "template": null, "size": 12, "halo": true, "minZoom": 9, "priority": "size", "placement": "auto"},
  "popup": {"title": "{{name}}", "fields": ["type", "capacity", "territory_id"], "actions": ["open", "documents", "instruction"]},
  "opacity": 1, "minZoom": 0, "maxZoom": 22,
  "filter": null,
  "legend": {"title": {"ru": "Население на км²"}, "format": {"precision": 0}, "show": true},
  "time": {"field": "occurred_at", "mode": "instant", "step": "day"},
  "extrusion": null,
  "raster": null
}
```

## Рендереры
- `simple` — фиксированные цвет/размер/иконка (`color` — токен палитры, например `"categorical.1"` или семантический `"danger"`, либо `#hex` для пользовательских).
- `categorized` — `field`, `categories[{value, label, color, icon?, size?}]`, `other{color}`.
- `graduated` — `field`, `method: equal|quantile|jenks|manual|log|stddev`, `classes`, `breaks[]`, `palette{name, reverse}`, `normalizeBy?`, `visual.target: fill|size|both`.
- `heatmap` — `weightField?`, `radius`, `intensity`, `palette`.
- `proportional` — размер по значению (точки).
- `rule` — массив правил `{filter, style}` (расширенный режим).

## Компиляция
`packages/map-style`: LayerStyle + схема датасета + тема → массив слоёв MapLibre (`circle`, `symbol`, `line`, `fill`, `fill-extrusion`, `heatmap`) с выражениями `["step"/"match"/"interpolate"]`, source-layer `layer`, фильтры по зуму; кластеризация — серверная (тайлы с `point_count`) или клиентская (GeoJSON-источник `cluster: true`) — выбирается по размеру слоя. Легенда генерируется из тех же классов/категорий; печать использует ту же спецификацию.

## Палитры
Имена из дизайн-системы: `categorical`, `blue`, `teal`, `orange`, `viridis`, `red-blue`, `brown-teal`, `status`. Классы 3–9. Для тёмной темы — автоматические варианты.
