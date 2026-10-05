import { describe, expect, it } from 'vitest'
import {
  EVENT_CATALOG_PARTS,
  EVENT_PAYLOADS,
  EVENT_TYPES,
  EVENT_VERSIONS,
  eventVersion,
} from '../catalog.js'

const domainOf = (type: string) => type.split('.')[0] ?? ''

/** Каталог событий по файлам владельцев (ADR-0189). */
describe('каталог событий', () => {
  it('тип события не повторяется в двух частях — спред молча перекрыл бы его', () => {
    const owners = new Map<string, string[]>()
    for (const [part, events] of Object.entries(EVENT_CATALOG_PARTS)) {
      for (const type of Object.keys(events)) owners.set(type, [...(owners.get(type) ?? []), part])
    }
    const repeated = [...owners].filter(([, parts]) => parts.length > 1)
    expect(repeated).toEqual([])
  })

  it('домен события целиком принадлежит одной части', () => {
    const owners = new Map<string, Set<string>>()
    for (const [part, events] of Object.entries(EVENT_CATALOG_PARTS)) {
      for (const type of Object.keys(events)) {
        const domain = domainOf(type)
        owners.set(domain, new Set([...(owners.get(domain) ?? []), part]))
      }
    }
    const split = [...owners]
      .filter(([, parts]) => parts.size > 1)
      .map(([domain, parts]) => `${domain}: ${[...parts].join(', ')}`)
    expect(split).toEqual([])
  })

  it('общий каталог — ровно объединение частей', () => {
    const fromParts = Object.values(EVENT_CATALOG_PARTS)
      .flatMap((events) => Object.keys(events))
      .sort()
    expect([...EVENT_TYPES].sort()).toEqual(fromParts)
    for (const [, events] of Object.entries(EVENT_CATALOG_PARTS)) {
      for (const [type, schema] of Object.entries(events)) {
        expect(EVENT_PAYLOADS[type as keyof typeof EVENT_PAYLOADS]).toBe(schema)
      }
    }
  })

  it('версии нагрузок — у известных типов, целые от 2: первая не записывается', () => {
    for (const [type, version] of Object.entries(EVENT_VERSIONS)) {
      expect(EVENT_TYPES).toContain(type)
      expect(Number.isInteger(version) && (version ?? 0) >= 2).toBe(true)
    }
    expect(eventVersion('object.created')).toBe(EVENT_VERSIONS['object.created'] ?? 1)
  })
})
