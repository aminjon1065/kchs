import { useEffect, useRef } from 'react'

export interface Hotkey {
  /** Комбинация в формате `mod+k`, `g h`, `shift+?`. `mod` — ⌘ на macOS, Ctrl иначе. */
  combo: string
  handler: (event: KeyboardEvent) => void
  /** Разрешить срабатывание в полях ввода. */
  allowInInput?: boolean
  description?: string
  enabled?: boolean
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** Коды клавиш: сравнение по `event.code` — кириллическая раскладка не мешает. */
const CODE_BY_KEY: Record<string, string> = {
  a: 'KeyA',
  b: 'KeyB',
  c: 'KeyC',
  d: 'KeyD',
  e: 'KeyE',
  f: 'KeyF',
  g: 'KeyG',
  h: 'KeyH',
  i: 'KeyI',
  j: 'KeyJ',
  k: 'KeyK',
  l: 'KeyL',
  m: 'KeyM',
  n: 'KeyN',
  o: 'KeyO',
  p: 'KeyP',
  q: 'KeyQ',
  r: 'KeyR',
  s: 'KeyS',
  t: 'KeyT',
  u: 'KeyU',
  v: 'KeyV',
  w: 'KeyW',
  x: 'KeyX',
  y: 'KeyY',
  z: 'KeyZ',
  '1': 'Digit1',
  '2': 'Digit2',
  '3': 'Digit3',
  '4': 'Digit4',
  '5': 'Digit5',
  '6': 'Digit6',
  '7': 'Digit7',
  '8': 'Digit8',
  '9': 'Digit9',
  '0': 'Digit0',
  '\\': 'Backslash',
  '/': 'Slash',
  '.': 'Period',
  ',': 'Comma',
  '?': 'Slash',
  enter: 'Enter',
  escape: 'Escape',
  space: 'Space',
  tab: 'Tab',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  backspace: 'Backspace',
  delete: 'Delete',
}

interface ParsedCombo {
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  code: string
}

function parseChord(chord: string): ParsedCombo {
  const parts = chord.toLowerCase().split('+')
  const key = parts[parts.length - 1] ?? ''
  return {
    mod: parts.includes('mod'),
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift') || key === '?',
    alt: parts.includes('alt'),
    code: CODE_BY_KEY[key] ?? key,
  }
}

function matches(event: KeyboardEvent, chord: ParsedCombo): boolean {
  const modPressed = isMac ? event.metaKey : event.ctrlKey
  if (chord.mod !== modPressed) return false
  if (chord.ctrl && !event.ctrlKey) return false
  if (chord.shift !== event.shiftKey) return false
  if (chord.alt !== event.altKey) return false
  return event.code === chord.code
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Горячие клавиши приложения (03-ui/04-interaction-patterns.md §8).
 * Поддерживает последовательности («G H») и сравнение по коду клавиши.
 */
export function useHotkeys(hotkeys: Hotkey[]): void {
  const pendingRef = useRef<{ chord: ParsedCombo; at: number } | null>(null)
  const hotkeysRef = useRef(hotkeys)
  hotkeysRef.current = hotkeys

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const editable = isEditable(event.target)

      for (const hotkey of hotkeysRef.current) {
        if (hotkey.enabled === false) continue
        if (editable && !hotkey.allowInInput) continue

        const chords = hotkey.combo.split(' ').map(parseChord)

        if (chords.length === 1) {
          if (matches(event, chords[0]!)) {
            event.preventDefault()
            hotkey.handler(event)
            pendingRef.current = null
            return
          }
          continue
        }

        // Последовательность из двух аккордов: «G H»
        const [first, second] = chords as [ParsedCombo, ParsedCombo]
        const pending = pendingRef.current
        if (pending && Date.now() - pending.at < 1200 && sameChord(pending.chord, first)) {
          if (matches(event, second)) {
            event.preventDefault()
            hotkey.handler(event)
            pendingRef.current = null
            return
          }
        } else if (matches(event, first)) {
          pendingRef.current = { chord: first, at: Date.now() }
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function sameChord(a: ParsedCombo, b: ParsedCombo): boolean {
  return a.code === b.code && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt
}

/** Человекочитаемая запись сочетания для подсказок и шпаргалки. */
export function formatShortcut(combo: string): string {
  return combo
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((part) => {
          switch (part.toLowerCase()) {
            case 'mod':
              return isMac ? '⌘' : 'Ctrl'
            case 'shift':
              return isMac ? '⇧' : 'Shift'
            case 'alt':
              return isMac ? '⌥' : 'Alt'
            case 'ctrl':
              return isMac ? '⌃' : 'Ctrl'
            case 'enter':
              return '↵'
            case 'escape':
              return 'Esc'
            case 'up':
              return '↑'
            case 'down':
              return '↓'
            default:
              return part.toUpperCase()
          }
        })
        .join(isMac ? '' : '+'),
    )
    .join(' ')
}
