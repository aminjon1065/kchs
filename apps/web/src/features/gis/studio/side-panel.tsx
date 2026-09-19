import { useStudio } from './context.js'
import { EditPanel } from './edit-panel.js'
import { StylePanel } from './style-panel.js'

/** Правая панель студии: одна из панелей `StudioPanelKind`. */
export function StudioSidePanel() {
  const { panel } = useStudio()
  if (!panel) return null
  switch (panel.kind) {
    case 'style':
      return <StylePanel layerId={panel.layerId} />
    case 'edit':
      return <EditPanel layerId={panel.layerId} />
  }
}
