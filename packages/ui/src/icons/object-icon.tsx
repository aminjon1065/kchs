import {
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  Briefcase,
  Building2,
  Calendar,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  Database,
  FileBox,
  FileSpreadsheet,
  FileText,
  Folder,
  Gauge,
  Globe,
  Inbox,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  ListFilter,
  Lock,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  Notebook,
  Plug,
  Presentation,
  Radio,
  Shield,
  Sparkles,
  Table2,
  Users,
  Video,
  Workflow,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

/**
 * Фиксированный набор глифов типов объектов (03-ui/02-design-system.md §2).
 * Ключи совпадают с `object.type` из глоссария.
 */
const ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  space: LayoutGrid,
  folder: Folder,
  view: ListFilter,
  conversation: MessageSquare,
  source: Plug,
  dataset: Table2,
  pipeline: Workflow,
  query: Database,
  metric: Gauge,
  chart: BarChart3,
  dashboard: LayoutDashboard,
  notebook: Notebook,
  report: FileSpreadsheet,
  form: ClipboardList,
  alert: AlertTriangle,
  layer: Layers,
  map: MapIcon,
  territory: MapPin,
  analysis: Sparkles,
  basemap: Globe,
  document: FileText,
  document_type: FileBox,
  journal: ClipboardList,
  route: Workflow,
  template: FileBox,
  case: Briefcase,
  correspondent: Building2,
  file: FileText,
  project: Presentation,
  task: CheckSquare,
  meeting: Video,
  recording: Radio,
  protocol: FileText,
  calendar: Calendar,
  event: CalendarDays,
  page: FileText,
  rule: Workflow,
  integration: Plug,
  webhook: Link2,
  user: Users,
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
  const Icon = ICONS[type] ?? FileText
  return <Icon aria-hidden {...props} />
}

export function hasObjectIcon(type: string): boolean {
  return type in ICONS
}

export { ICONS as OBJECT_ICONS }
