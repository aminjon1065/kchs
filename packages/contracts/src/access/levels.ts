import { z } from 'zod'

/** Упорядоченные уровни доступа: none < view < comment < edit < manage < owner. */
export const LEVELS = ['none', 'view', 'comment', 'edit', 'manage', 'owner'] as const
export const Level = z.enum(LEVELS)
export type Level = z.infer<typeof Level>

export const LEVEL_VALUE: Record<Level, number> = {
  none: 0,
  view: 1,
  comment: 2,
  edit: 3,
  manage: 4,
  owner: 5,
}

export const LEVEL_BY_VALUE: Record<number, Level> = {
  0: 'none',
  1: 'view',
  2: 'comment',
  3: 'edit',
  4: 'manage',
  5: 'owner',
}

export function levelValue(level: Level): number {
  return LEVEL_VALUE[level]
}

export function levelFromValue(value: number): Level {
  return LEVEL_BY_VALUE[Math.max(0, Math.min(5, Math.trunc(value)))] ?? 'none'
}

export function atLeast(actual: Level, required: Level): boolean {
  return LEVEL_VALUE[actual] >= LEVEL_VALUE[required]
}

export function maxLevel(...levels: Level[]): Level {
  return levels.reduce<Level>((acc, l) => (LEVEL_VALUE[l] > LEVEL_VALUE[acc] ? l : acc), 'none')
}

export function minLevel(...levels: Level[]): Level {
  return levels.reduce<Level>((acc, l) => (LEVEL_VALUE[l] < LEVEL_VALUE[acc] ? l : acc), 'owner')
}

/** Роли участника пространства и уровень по умолчанию (03-access-model.md §4). */
export const SPACE_ROLES = ['viewer', 'member', 'editor', 'admin'] as const
export const SpaceRole = z.enum(SPACE_ROLES)
export type SpaceRole = z.infer<typeof SpaceRole>

export const SPACE_ROLE_DEFAULT_LEVEL: Record<SpaceRole, Level> = {
  viewer: 'view',
  member: 'comment',
  editor: 'edit',
  admin: 'manage',
}

export const SPACE_ROLE_VALUE: Record<SpaceRole, number> = {
  viewer: 1,
  member: 2,
  editor: 3,
  admin: 4,
}
