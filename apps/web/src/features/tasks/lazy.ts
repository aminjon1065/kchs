import { lazy } from 'react'

/**
 * Компоненты «tasks» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyCreateTaskDialog = lazy(() =>
  import('./task-dialogs.js').then((module) => ({ default: module.CreateTaskDialog })),
)

export const LazyRowTasks = lazy(() =>
  import('./row-tasks.js').then((module) => ({ default: module.RowTasks })),
)

export const LazyIssuedWidget = lazy(() =>
  import('./home-widgets.js').then((module) => ({ default: module.IssuedWidget })),
)

export const LazyTeamWidget = lazy(() =>
  import('./home-widgets.js').then((module) => ({ default: module.TeamWidget })),
)

export const LazyMyTasksWidget = lazy(() =>
  import('./my-tasks-widget.js').then((module) => ({ default: module.MyTasksWidget })),
)

export const LazyDueInput = lazy(() =>
  import('./due-input.js').then((module) => ({ default: module.DueInput })),
)
