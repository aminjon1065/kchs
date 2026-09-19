import { Button, IconButton, Tooltip } from '@kchs/ui'
import { Info, Pentagon, Ruler, SquareDashedMousePointer, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '~/app/i18n.js'
import { BookmarksMenu } from './bookmarks.js'
import { BoxSelect } from './box-select.js'
import { EDIT_TOOL, useStudio } from './context.js'
import { IdentifyTool } from './identify.js'
import { MapSearch } from './map-search.js'
import { MEASURE_TOOLS, MeasureTool } from './measure-tool.js'

/** Инструменты навигации студии (значения `StudioContextValue.tool`). */
const TOOLS = {
  select: 'select',
  identify: 'identify',
  ...MEASURE_TOOLS,
} as const

/**
 * Инструменты карты (P2-E02 S02, 03-screens.md §10, ADR-0073): выделение рамкой
 * (и Shift+перетаскивание в любом режиме), идентификация, измерение расстояния
 * и площади, закладки, поиск (адрес, территория, объект, координаты). Режим
 * инструмента — `useStudio().tool`: пока он включён, щелчок по карте не
 * открывает карточку объекта. Esc выключает инструмент.
 */
export function NavigationTools() {
  const t = useT()
  const studio = useStudio()
  const { tool, setTool, selection } = studio
  const selectInView = useRef<(() => void) | null>(null)

  // Esc — выйти из режима (у измерения свой порядок: сначала сброс точек, у
  // правки объектов — свой выход с вопросом о несохранённом)
  useEffect(() => {
    if (tool !== TOOLS.select && tool !== TOOLS.identify) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [role="dialog"], [role="menu"]')) return
      setTool(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, setTool])

  // Пока идёт правка объектов, щелчки принадлежат рисованию: инструменты навигации
  // включаются после «Готово»
  const editing = tool === EDIT_TOOL
  const toggle = (next: string) => setTool(tool === next ? null : next)
  const button = (id: string, label: string, icon: ReactNode, shortcutHint?: string) => (
    <Tooltip
      content={
        editing
          ? `${label}. ${t('gis.tools.editingHint')}`
          : shortcutHint
            ? `${label}. ${shortcutHint}`
            : label
      }
    >
      <IconButton
        label={label}
        size="md"
        active={tool === id}
        aria-pressed={tool === id}
        disabled={editing}
        onClick={() => toggle(id)}
      >
        {icon}
      </IconButton>
    </Tooltip>
  )

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('gis.tools.label')}
        className="flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-sm"
      >
        {button(
          TOOLS.select,
          t('gis.tools.select'),
          <SquareDashedMousePointer className="size-4" aria-hidden />,
          t('gis.tools.selectHint'),
        )}
        {button(TOOLS.identify, t('gis.tools.identify'), <Info className="size-4" aria-hidden />)}
        {button(TOOLS.line, t('gis.measure.distance'), <Ruler className="size-4" aria-hidden />)}
        {button(TOOLS.area, t('gis.measure.area'), <Pentagon className="size-4" aria-hidden />)}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
        <BookmarksMenu />
      </div>
      {/* Живая область: число выделенных объявляется скринридером после рамки и «выделить всё» */}
      <div aria-live="polite" className="flex">
        {selection.length > 0 ? (
          <div className="flex items-center gap-1 rounded-md border border-line bg-surface py-0.5 pl-2 pr-0.5 text-xs text-fg-secondary shadow-sm">
            <span className="tabular">{t('gis.tools.selected', { count: selection.length })}</span>
            <IconButton
              label={t('gis.tools.clearSelection')}
              size="sm"
              onClick={() => studio.setSelection([])}
            >
              <X className="size-3.5" aria-hidden />
            </IconButton>
          </div>
        ) : null}
      </div>
      <MapSearch />
      <BoxSelect selectInViewRef={selectInView} />
      <IdentifyTool />
      <MeasureTool />
      {tool === TOOLS.select ? (
        <SelectPanel onSelectInView={() => selectInView.current?.()} onDone={() => setTool(null)} />
      ) : null}
    </>
  )
}

/** Подсказка режима «Рамка» и то же без мыши: выделить всё в охвате карты. */
function SelectPanel({
  onSelectInView,
  onDone,
}: {
  onSelectInView: () => void
  onDone: () => void
}) {
  const t = useT()
  const { map, selection, setSelection } = useStudio()
  if (!map) return null
  return createPortal(
    <section
      aria-label={t('gis.tools.select')}
      className="absolute bottom-8 left-1/2 z-20 flex w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 flex-col gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 font-sans shadow-md"
    >
      <p className="text-xs text-fg-muted">{t('gis.tools.selectHelp')}</p>
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onSelectInView}>
          {t('gis.tools.selectInView')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={selection.length === 0}
          onClick={() => setSelection([])}
        >
          {t('gis.tools.clearSelection')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onDone}>
          {t('gis.tools.finish')}
        </Button>
      </div>
    </section>,
    map.getContainer(),
  )
}
