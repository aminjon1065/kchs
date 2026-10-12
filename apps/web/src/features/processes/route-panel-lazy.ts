import { lazy } from 'react'

/**
 * Панель маршрута объекта для карточек модулей (ADR-0202) — ленивой: компоненты
 * линии маршрута и решений грузятся с вкладкой, а не с чанком потребителя.
 */
export const ObjectRoutePanel = lazy(() =>
  import('./route-panel.js').then((module) => ({ default: module.ObjectRoutePanel })),
)
