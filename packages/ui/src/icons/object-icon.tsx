import {
  AlertTriangle,
  BarChart3,
  Bell,
  BookMarked,
  BookOpen,
  Bot,
  Box,
  Briefcase,
  Building2,
  Cable,
  Calendar,
  CalendarDays,
  CheckSquare,
  Clapperboard,
  ClipboardPen,
  Contact,
  File,
  FileCog,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderKanban,
  Gauge,
  Globe,
  Inbox,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  LayoutTemplate,
  ListFilter,
  Lock,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  Notebook,
  Plug,
  Radar,
  Route,
  ScrollText,
  SearchCode,
  Shield,
  Table2,
  User,
  Users,
  Video,
  Webhook,
  Workflow,
  Zap,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

/**
 * Фиксированный набор глифов типов объектов (03-ui/02-design-system.md §Иконки).
 * Ключи совпадают с `object.type` из глоссария; у каждого типа реестра свой глиф —
 * документ, файл и страница не должны выглядеть одинаково (тест object-icon.test.ts).
 */
const ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  space: LayoutGrid,
  folder: Folder,
  view: ListFilter,
  conversation: MessageSquare,
  source: Plug,
  dataset: Table2,
  pipeline: Workflow,
  query: SearchCode,
  metric: Gauge,
  chart: BarChart3,
  dashboard: LayoutDashboard,
  notebook: Notebook,
  report: FileSpreadsheet,
  form: ClipboardPen,
  alert: AlertTriangle,
  layer: Layers,
  map: MapIcon,
  territory: MapPin,
  analysis: Radar,
  basemap: Globe,
  document: FileText,
  document_type: FileCog,
  journal: BookMarked,
  route: Route,
  template: LayoutTemplate,
  case: Briefcase,
  correspondent: Contact,
  file: File,
  project: FolderKanban,
  task: CheckSquare,
  meeting: Video,
  recording: Clapperboard,
  protocol: ScrollText,
  calendar: Calendar,
  event: CalendarDays,
  page: BookOpen,
  rule: Zap,
  integration: Cable,
  webhook: Webhook,
  user: User,
  unit: Building2,
  group: Users,
  role: Shield,
  inbox: Inbox,
  notification: Bell,
  assistant: Bot,
  lock: Lock,
}

export interface ObjectIconProps extends SVGProps<SVGSVGElement> {
  type: string
}

export function ObjectIcon({ type, ...props }: ObjectIconProps) {
  // Неизвестный тип — нейтральный «объект», а не глиф документа или файла
  const Icon = ICONS[type] ?? Box
  return <Icon aria-hidden {...props} />
}

export function hasObjectIcon(type: string): boolean {
  return type in ICONS
}

export { ICONS as OBJECT_ICONS }
