import { MAP_IMAGE_SIZE, type MapImageRequest } from '@kchs/map-style'
import {
  Ambulance,
  Anchor,
  Antenna,
  Baby,
  Biohazard,
  Building,
  Building2,
  Bus,
  Camera,
  Car,
  Church,
  CircleAlert,
  CircleDot,
  CloudRain,
  Construction,
  Crosshair,
  Dam,
  Droplet,
  Factory,
  FireExtinguisher,
  Flag,
  Flame,
  Fuel,
  GraduationCap,
  Hospital,
  Hotel,
  House,
  Info,
  Landmark,
  Library,
  LifeBuoy,
  type LucideIcon,
  MapPin,
  Megaphone,
  Mountain,
  MountainSnow,
  Package,
  Phone,
  Pill,
  Plane,
  Plug,
  Radiation,
  RadioTower,
  Route,
  School,
  Shield,
  ShieldAlert,
  Ship,
  Signpost,
  Siren,
  Snowflake,
  Sprout,
  Star,
  Stethoscope,
  Store,
  Sun,
  Tent,
  Thermometer,
  Tornado,
  Tractor,
  TrainFront,
  TreePine,
  Trees,
  TriangleAlert,
  Truck,
  Users,
  Warehouse,
  Waves,
  Wheat,
  Wind,
  Zap,
} from 'lucide-react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { SDF_BUFFER, sdfFromMask } from './map-sdf.js'

/**
 * Значки карты (07-gis-engine.md §4): набор Lucide для объектов защиты,
 * инфраструктуры, ЧС и природы — по имени в стиле слоя (`school`, `hospital`).
 * Набор ограничен, чтобы чанк карты не тянул все значки; неизвестное имя
 * рисуется кружком.
 */
export const MAP_ICONS: Readonly<Record<string, LucideIcon>> = {
  school: School,
  'graduation-cap': GraduationCap,
  baby: Baby,
  hospital: Hospital,
  stethoscope: Stethoscope,
  pill: Pill,
  ambulance: Ambulance,
  church: Church,
  landmark: Landmark,
  library: Library,
  store: Store,
  hotel: Hotel,
  shield: Shield,
  'shield-alert': ShieldAlert,
  siren: Siren,
  flame: Flame,
  'fire-extinguisher': FireExtinguisher,
  'triangle-alert': TriangleAlert,
  'circle-alert': CircleAlert,
  'life-buoy': LifeBuoy,
  tent: Tent,
  biohazard: Biohazard,
  radiation: Radiation,
  megaphone: Megaphone,
  house: House,
  building: Building,
  'building-2': Building2,
  factory: Factory,
  warehouse: Warehouse,
  construction: Construction,
  zap: Zap,
  plug: Plug,
  'radio-tower': RadioTower,
  antenna: Antenna,
  fuel: Fuel,
  dam: Dam,
  droplet: Droplet,
  waves: Waves,
  anchor: Anchor,
  route: Route,
  signpost: Signpost,
  car: Car,
  bus: Bus,
  truck: Truck,
  'train-front': TrainFront,
  plane: Plane,
  ship: Ship,
  tractor: Tractor,
  mountain: Mountain,
  'mountain-snow': MountainSnow,
  trees: Trees,
  'tree-pine': TreePine,
  wheat: Wheat,
  sprout: Sprout,
  wind: Wind,
  'cloud-rain': CloudRain,
  snowflake: Snowflake,
  thermometer: Thermometer,
  tornado: Tornado,
  sun: Sun,
  'map-pin': MapPin,
  flag: Flag,
  star: Star,
  'circle-dot': CircleDot,
  users: Users,
  phone: Phone,
  camera: Camera,
  info: Info,
  crosshair: Crosshair,
  package: Package,
}

/** Толщина линий значка на карте: тоньше 2,5 при малом размере теряется. */
const STROKE = 2.5

/** Значок для легенды и редактора стиля — тот же глиф, что на карте. */
export function renderMapIcon(name: string, color: string, size: number) {
  const Icon = MAP_ICONS[name]
  return Icon ? <Icon size={size} color={color} strokeWidth={STROKE} aria-hidden /> : null
}

/** Разметка SVG значка: рендер в отсоединённый узел — без react-dom/server в чанке карты. */
function iconSvg(Icon: LucideIcon): string {
  const host = document.createElement('div')
  const root = createRoot(host)
  flushSync(() => root.render(<Icon size={24} color="#000" strokeWidth={STROKE} />))
  const svg = host.innerHTML
  root.unmount()
  return svg
}

async function drawIcon(context: CanvasRenderingContext2D, name: string, box: number, at: number) {
  const Icon = MAP_ICONS[name]
  if (!Icon) return false
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(Icon))}`
  await image.decode()
  context.drawImage(image, at, at, box, box)
  return true
}

function drawShape(context: CanvasRenderingContext2D, shape: string, box: number, at: number) {
  context.beginPath()
  if (shape === 'square') {
    const inset = box * 0.12
    context.rect(at + inset, at + inset, box - inset * 2, box - inset * 2)
  } else if (shape === 'triangle') {
    context.moveTo(at + box / 2, at + box * 0.06)
    context.lineTo(at + box * 0.96, at + box * 0.9)
    context.lineTo(at + box * 0.04, at + box * 0.9)
    context.closePath()
  } else {
    context.arc(at + box / 2, at + box / 2, box / 2, 0, Math.PI * 2)
  }
  context.fill()
}

export interface MapImageData {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * Изображение фигуры или значка для MapLibre (SDF, ADR-0065): маска рисуется на
 * холсте с запасом под ореол, альфа заменяется полем расстояний. Логический
 * размер без запаса — `MAP_IMAGE_SIZE`: `icon-size` = диаметр / 32.
 */
export async function rasterizeMapImage(
  request: MapImageRequest,
  pixelRatio: number,
): Promise<MapImageData> {
  const box = Math.round(MAP_IMAGE_SIZE * pixelRatio)
  const buffer = Math.round(SDF_BUFFER * pixelRatio)
  const side = box + buffer * 2
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('canvas-2d-unavailable')
  context.fillStyle = '#000'
  const drawn = request.kind === 'icon' && (await drawIcon(context, request.name, box, buffer))
  if (!drawn) drawShape(context, request.kind === 'shape' ? request.name : 'circle', box, buffer)
  const mask = context.getImageData(0, 0, side, side).data
  return { width: side, height: side, data: sdfFromMask(mask, side, side) }
}
