import type { ReactNode } from 'react'
import type { ScreenKey, TabState } from './types.js'

/**
 * Реестр экранов оболочки: модуль регистрирует свои экраны и типы объектов
 * (01-project-structure.md §apps/web).
 */
export interface ScreenDefinition {
  key: ScreenKey
  /** Ключ словаря с названием экрана (`shell.rail.home`), не сам текст. */
  titleKey: string
  icon: string
  render: (tab: TabState) => ReactNode
  /** Что показывать в навигаторе при активном модуле. */
  navigator?: () => ReactNode
}

export interface ObjectViewDefinition {
  type: string
  render: (tab: TabState) => ReactNode
}

const screens = new Map<ScreenKey, ScreenDefinition>()
const objectViews = new Map<string, ObjectViewDefinition>()

export function registerScreen(definition: ScreenDefinition): void {
  screens.set(definition.key, definition)
}

export function registerObjectView(definition: ObjectViewDefinition): void {
  objectViews.set(definition.type, definition)
}

export function getScreen(key: ScreenKey): ScreenDefinition | undefined {
  return screens.get(key)
}

export function getObjectView(type: string): ObjectViewDefinition | undefined {
  return objectViews.get(type)
}
