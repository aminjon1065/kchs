/**
 * MapLibre GL со стилями — ленивый модуль карты: отдельный чанк, экраны без карт
 * его не скачивают. Стили элементов MapLibre (атрибуция, масштаб) переопределены
 * токенами дизайн-системы в `map.css`; инлайновых стилей нет (CSP, ADR-0043).
 */
import 'maplibre-gl/dist/maplibre-gl.css'
import '../styles/map.css'
import * as maplibregl from 'maplibre-gl'
// Воркер MapLibre собирает Vite (`?worker&url`): адрес по умолчанию MapLibre
// вычисляет от места своего модуля, а после сборки в чанк такого файла нет
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

maplibregl.setWorkerUrl(workerUrl)

export { maplibregl }
