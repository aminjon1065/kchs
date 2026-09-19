import { STYLE_PALETTES, type StylePalette, type StylePaletteName } from '@kchs/contracts'
import {
  DIVERGING_RAMPS,
  MAP_COLOR_TOKENS,
  type MapTheme,
  paletteColors,
  resolveColor,
  SEQUENTIAL_RAMPS,
} from '@kchs/map-style'
import { ArrowLeftRight, Ban, ChevronDown, Search } from 'lucide-react'
import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useState } from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { Button, IconButton } from '../primitives/button.js'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../primitives/controls.js'
import { Input } from '../primitives/input.js'
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/overlays.js'
import { MAP_ICONS, renderMapIcon } from './map-icons.js'

/**
 * Элементы редактора стиля слоя (07-gis-engine.md §4, ADR-0075): палитры и цвета
 * — только имена токенов дизайн-системы (`categorical.3`, `danger`, `blue.5`) или
 * свой `#rrggbb`, образцы — в цветах текущей темы карты (`useMapTheme`), значки —
 * из набора карты (`MAP_ICONS`), те же, что MapLibre рисует SDF-изображениями.
 */

const HEX = /^#[0-9a-fA-F]{6}$/
const CATEGORICAL = 8
const STEPS = 7
const RAMPS = [...SEQUENTIAL_RAMPS, ...DIVERGING_RAMPS] as const
/** Смысловые цвета и «прочее» — в порядке палитры редактора. */
const SEMANTIC = [...MAP_COLOR_TOKENS, 'other'] as const

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

/** Полоса цветов: классы шкалы или цвета категорий — SVG-атрибутами (CSP). */
export function PaletteRamp({
  colors,
  className,
}: {
  colors: readonly string[]
  className?: string
}) {
  return (
    <svg
      className={cn('h-3 w-16 shrink-0 rounded-xs', className)}
      viewBox={`0 0 ${Math.max(1, colors.length)} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {colors.map((color, i) => (
        <rect key={`${color}-${i}`} x={i} y={0} width={1} height={1} fill={color} />
      ))}
    </svg>
  )
}

/** Образец цвета: квадрат со скруглением и тонкой рамкой (видна и на цвете фона). */
function Swatch({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      aria-hidden="true"
    >
      <rect
        x={0.5}
        y={0.5}
        width={size - 1}
        height={size - 1}
        rx={3}
        fill={color}
        className="stroke-line-strong"
      />
    </svg>
  )
}

/** Подпись цвета стиля: «Категория 3», «Опасность», «Синяя, шаг 5», «#1A2B3C». */
export function useMapColorLabel(): (value: string) => string {
  const t = useUiT()
  return (value: string) => {
    if (HEX.test(value)) return value.toUpperCase()
    if (value === 'auto') return t('ui.map.colors.auto')
    const [name = '', step] = value.split('.')
    if (name === 'categorical') return t('ui.map.colors.categorical', { n: step ?? '1' })
    if ((RAMPS as readonly string[]).includes(name) || name === 'status') {
      return t('ui.map.colors.step', {
        palette: t(`ui.map.palettes.${name}`),
        n: step ?? '5',
      })
    }
    if ((SEMANTIC as readonly string[]).includes(name)) return t(`ui.map.colors.${name}`)
    return value
  }
}

export interface MapPalettePickerProps {
  value: StylePalette
  onChange: (value: StylePalette) => void
  /** Тема карты: образцы шкал в её цветах; пока не прочитана — без образцов. */
  theme: MapTheme | null
  /** Классов в образце шкалы. */
  classes?: number
  /** Палитры на выбор; по умолчанию — все палитры дизайн-системы. */
  palettes?: readonly StylePaletteName[]
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

/**
 * Выбор палитры классов: шкалы и категории дизайн-системы с образцом в цветах
 * темы, рядом — обратный порядок (большему значению — светлый край).
 */
export function MapPalettePicker({
  value,
  onChange,
  theme,
  classes = 5,
  palettes = STYLE_PALETTES,
  disabled,
  id,
  'aria-label': ariaLabel,
}: MapPalettePickerProps) {
  const t = useUiT()
  const colors = (name: StylePaletteName) =>
    theme ? paletteColors(theme, { name, reverse: value.reverse }, classes) : []
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select
        value={value.name}
        disabled={disabled}
        onValueChange={(name) => onChange({ ...value, name: name as StylePaletteName })}
      >
        <SelectTrigger id={id} aria-label={ariaLabel ?? t('ui.map.palette.label')}>
          <span className="flex min-w-0 items-center gap-2">
            <PaletteRamp colors={colors(value.name)} />
            <span className="truncate">{t(`ui.map.palettes.${value.name}`)}</span>
          </span>
        </SelectTrigger>
        <SelectContent>
          {palettes.map((name) => (
            <SelectItem key={name} value={name}>
              <span className="flex items-center gap-2">
                <PaletteRamp colors={colors(name)} />
                {t(`ui.map.palettes.${name}`)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <IconButton
        label={t('ui.map.palette.reverse')}
        variant="secondary"
        active={value.reverse}
        aria-pressed={value.reverse}
        disabled={disabled}
        onClick={() => onChange({ ...value, reverse: !value.reverse })}
      >
        <ArrowLeftRight className="size-4" aria-hidden />
      </IconButton>
    </div>
  )
}

/**
 * Кнопка-поле, открывающая выбор: как поле ввода, с образцом и подписью; в
 * компактном виде (строки категорий и правил) — квадрат с одним образцом.
 */
const PickerTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { invalid?: boolean; compact?: boolean }
>(function PickerTrigger({ children, invalid, compact, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-invalid={invalid || undefined}
      className={cn(
        'flex h-[var(--control-h)] min-w-0 items-center rounded-sm border',
        'border-line-strong bg-surface text-left text-sm text-fg',
        'transition-colors duration-[var(--duration-fast)] hover:border-accent',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-muted',
        compact ? 'w-[var(--control-h)] shrink-0 justify-center' : 'w-full gap-2 px-2.5',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    >
      {children}
      {compact ? null : (
        <ChevronDown className="ml-auto size-4 shrink-0 text-fg-muted" aria-hidden />
      )}
    </button>
  )
})

function SwatchButton({
  color,
  label,
  selected,
  onSelect,
}: {
  color: string
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex size-6 items-center justify-center rounded-xs border',
        selected ? 'border-accent bg-accent-subtle' : 'border-transparent hover:border-line-strong',
      )}
    >
      <Swatch color={color} size={18} />
    </button>
  )
}

function PickerGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-2xs font-medium uppercase tracking-wide text-fg-muted">
        {title}
      </legend>
      {children}
    </fieldset>
  )
}

export interface MapColorPickerProps {
  /** Цвет стиля: токен палитры, смысловой токен, `auto` или `#rrggbb`. */
  value: string
  onChange: (value: string) => void
  theme: MapTheme | null
  /** Можно выбрать «Авто» — производный от основного цвета (обводка, кольцо). */
  allowAuto?: boolean
  /** Цвет образца «Авто»: производный цвет в теме. */
  autoColor?: string
  /** Только образец, без подписи: строки категорий и правил. */
  compact?: boolean
  disabled?: boolean
  invalid?: boolean
  id?: string
  'aria-label'?: string
}

/**
 * Выбор цвета стиля: категории палитры графиков, смысловые цвета, шаги шкал
 * карт и свой `#rrggbb`. Хранится имя токена — в тёмной теме цвет свой.
 */
export function MapColorPicker({
  value,
  onChange,
  theme,
  allowAuto = false,
  autoColor,
  compact = false,
  disabled,
  invalid,
  id,
  'aria-label': ariaLabel,
}: MapColorPickerProps) {
  const t = useUiT()
  const label = useMapColorLabel()
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(HEX.test(value) ? value : '')
  const colorOf = (token: string) =>
    token === 'auto'
      ? (autoColor ?? (theme ? resolveColor('other', theme).color : '#888888'))
      : theme
        ? resolveColor(token, theme).color
        : '#888888'
  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }
  const swatch = (token: string) => (
    <SwatchButton
      key={token}
      color={colorOf(token)}
      label={label(token)}
      selected={value === token}
      onSelect={() => pick(token)}
    />
  )
  const customValid = HEX.test(custom)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger
          id={id}
          disabled={disabled}
          invalid={invalid}
          compact={compact}
          title={compact ? label(value) : undefined}
          aria-label={`${ariaLabel ?? t('ui.map.colors.label')}: ${label(value)}`}
        >
          <Swatch color={colorOf(value)} size={compact ? 16 : 14} />
          {compact ? null : <span className="min-w-0 truncate">{label(value)}</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-3">
        {allowAuto ? (
          <Button
            variant={value === 'auto' ? 'subtle' : 'secondary'}
            size="sm"
            aria-pressed={value === 'auto'}
            icon={<Swatch color={colorOf('auto')} />}
            onClick={() => pick('auto')}
          >
            {t('ui.map.colors.auto')}
          </Button>
        ) : null}
        <PickerGroup title={t('ui.map.colors.groups.categorical')}>
          <div className="flex flex-wrap gap-1">
            {range(CATEGORICAL).map((n) => swatch(`categorical.${n}`))}
          </div>
        </PickerGroup>
        <PickerGroup title={t('ui.map.colors.groups.semantic')}>
          <div className="flex flex-wrap gap-1">{SEMANTIC.map((token) => swatch(token))}</div>
        </PickerGroup>
        <PickerGroup title={t('ui.map.colors.groups.ramps')}>
          <div className="flex flex-col gap-0.5">
            {RAMPS.map((ramp) => (
              <div key={ramp} className="flex gap-1">
                {range(STEPS).map((n) => swatch(`${ramp}.${n}`))}
              </div>
            ))}
          </div>
        </PickerGroup>
        <PickerGroup title={t('ui.map.colors.groups.custom')}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (customValid) pick(custom.toUpperCase())
            }}
          >
            <Input
              mono
              value={custom}
              maxLength={7}
              placeholder="#1F6FEB"
              aria-label={t('ui.map.colors.hex')}
              invalid={custom !== '' && !customValid}
              prefix={customValid ? <Swatch color={custom} /> : undefined}
              onChange={(event) => {
                const next = event.target.value.trim()
                setCustom(next.startsWith('#') || next === '' ? next : `#${next}`)
              }}
            />
            <Button type="submit" size="sm" disabled={!customValid}>
              {t('ui.map.colors.apply')}
            </Button>
          </form>
        </PickerGroup>
      </PopoverContent>
    </Popover>
  )
}

export interface MapIconPickerProps {
  /** Имя значка из набора карты; null — без значка. */
  value: string | null
  onChange: (value: string | null) => void
  /** Цвет образцов — цвет точек. */
  color: string
  /** Можно убрать значок (точка фигурой). */
  allowNone?: boolean
  /** Только значок, без подписи: строки категорий и правил. */
  compact?: boolean
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

/** Выбор значка точек из набора карты: сетка с поиском по названию. */
export function MapIconPicker({
  value,
  onChange,
  color,
  allowNone = true,
  compact = false,
  disabled,
  id,
  'aria-label': ariaLabel,
}: MapIconPickerProps) {
  const t = useUiT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const name = (icon: string) => t(`ui.map.icons.${icon}`)
  const current = value && MAP_ICONS[value] ? name(value) : t('ui.map.icons.none')
  const needle = query.trim().toLowerCase()
  const icons = Object.keys(MAP_ICONS).filter(
    (icon) => !needle || icon.includes(needle) || name(icon).toLowerCase().includes(needle),
  )
  const pick = (next: string | null) => {
    onChange(next)
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <PickerTrigger
          id={id}
          disabled={disabled}
          compact={compact}
          title={compact ? current : undefined}
          aria-label={`${ariaLabel ?? t('ui.map.icons.label')}: ${current}`}
        >
          {value && MAP_ICONS[value] ? (
            <span className="flex shrink-0" aria-hidden="true">
              {renderMapIcon(value, color, 16)}
            </span>
          ) : (
            <Ban className="size-4 shrink-0 text-fg-muted" aria-hidden />
          )}
          {compact ? null : <span className="min-w-0 truncate">{current}</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('ui.map.icons.search')}
          aria-label={t('ui.map.icons.search')}
          prefix={<Search className="size-4" />}
        />
        <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto">
          {allowNone ? (
            <button
              type="button"
              aria-label={t('ui.map.icons.none')}
              title={t('ui.map.icons.none')}
              aria-pressed={value === null}
              onClick={() => pick(null)}
              className={cn(
                'flex size-8 items-center justify-center rounded-xs border text-fg-muted',
                value === null
                  ? 'border-accent bg-accent-subtle'
                  : 'border-transparent hover:border-line-strong',
              )}
            >
              <Ban className="size-4" aria-hidden />
            </button>
          ) : null}
          {icons.map((icon) => (
            <button
              key={icon}
              type="button"
              aria-label={name(icon)}
              title={name(icon)}
              aria-pressed={value === icon}
              onClick={() => pick(icon)}
              className={cn(
                'flex size-8 items-center justify-center rounded-xs border',
                value === icon
                  ? 'border-accent bg-accent-subtle'
                  : 'border-transparent hover:border-line-strong',
              )}
            >
              {renderMapIcon(icon, color, 18)}
            </button>
          ))}
        </div>
        {icons.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('ui.map.icons.nothing')}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
