import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import {
  buckets,
  deleteObject,
  getObjectStream,
  headObject,
  isMissingObject,
  listObjects,
  putObject,
  readObjectText,
} from '~/kernel/storage/s3.js'
import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'

/**
 * Хранилище базовых карт в бакете тайлов (ADR-0066):
 *
 *   <prefix>/vector/<ключ>/<версия>.pmtiles   архив сборки Planetiler
 *   <prefix>/vector/<ключ>/manifest.json      манифест kchs-basemap/1 (последним)
 *   <prefix>/glyphs/<шрифт>/<диапазон>.pbf     шрифты подписей
 *   <prefix>/sprites/basemap-<тема>[@2x].json|png
 *   <prefix>/raster/<id>/<метка адреса>/z/x/y  кэш растрового прокси
 *
 * `<prefix>` — `BASEMAPS_PREFIX` (по умолчанию `basemaps`).
 */

const SAFE_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

/** Манифест сборки — пишет `infra/basemaps/pmtiles_manifest.py`. */
export const BasemapManifest = z.object({
  format: z.literal('kchs-basemap/1'),
  key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
    .refine((key) => key !== 'none', 'ключ none занят системной подложкой'),
  name: z.string().trim().min(1).max(200),
  kind: z.literal('vector'),
  schema: z.literal('openmaptiles'),
  version: z.string().regex(SAFE_NAME),
  file: z.string().regex(SAFE_NAME).endsWith('.pmtiles'),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  tileType: z.literal('mvt'),
  tileCompression: z.string(),
  minZoom: z.number().int().min(0).max(24),
  maxZoom: z.number().int().min(0).max(24),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  center: z.tuple([z.number(), z.number(), z.number()]),
  tiles: z.number().int().nonnegative(),
  attribution: z.string().max(2000).nullable(),
  layers: z.array(z.string()),
})
export type BasemapManifest = z.infer<typeof BasemapManifest>

const root = () => config().BASEMAPS_PREFIX

export const basemapKeys = {
  archive: (key: string, file: string) => `${root()}/vector/${key}/${file}`,
  manifest: (key: string) => `${root()}/vector/${key}/manifest.json`,
  build: (key: string) => `${root()}/vector/${key}/`,
  glyph: (fontstack: string, range: string) => `${root()}/glyphs/${fontstack}/${range}.pbf`,
  sprite: (file: string) => `${root()}/sprites/${file}`,
  rasterCache: (id: string) => `${root()}/raster/${id}/`,
  rasterTile: (id: string, tag: string, z: number, x: number, y: number) =>
    `${root()}/raster/${id}/${tag}/${z}/${x}/${y}`,
}

/** Манифесты сборок в хранилище; повреждённый пропускается с предупреждением. */
export async function readManifests(): Promise<BasemapManifest[]> {
  const objects = await listObjects(`${root()}/vector/`, buckets.tiles())
  const manifests: BasemapManifest[] = []
  for (const item of objects) {
    if (!item.key.endsWith('/manifest.json')) continue
    try {
      const parsed = BasemapManifest.parse(
        JSON.parse(await readObjectText(item.key, buckets.tiles())),
      )
      // Ключ каталога и манифеста совпадают: иначе сборка перезаписала бы чужую
      if (basemapKeys.manifest(parsed.key) !== item.key) {
        throw errors.validation('Ключ манифеста не совпадает с каталогом сборки')
      }
      manifests.push(parsed)
    } catch (error) {
      logger().warn({ key: item.key, err: error }, 'манифест базовой карты пропущен')
    }
  }
  return manifests
}

/** Архивы сборки, кроме текущего, — остаются от прошлых версий. */
export async function removeStaleArchives(key: string, keep: string): Promise<number> {
  const objects = await listObjects(basemapKeys.build(key), buckets.tiles())
  const stale = objects.filter(
    (item) => item.key.endsWith('.pmtiles') && item.key !== basemapKeys.archive(key, keep),
  )
  for (const item of stale) await deleteObject(item.key, buckets.tiles())
  return stale.length
}

/** Сборка удалена из реестра — её файлы тоже, иначе `sync` вернёт подложку. */
export async function removeBuild(key: string): Promise<void> {
  const objects = await listObjects(basemapKeys.build(key), buckets.tiles())
  // Манифест первым: без него сборка уже не регистрируется
  const ordered = [...objects].sort((a, b) =>
    a.key.endsWith('/manifest.json') ? -1 : b.key.endsWith('/manifest.json') ? 1 : 0,
  )
  for (const item of ordered) await deleteObject(item.key, buckets.tiles())
}

/** Шрифт подписей; список через запятую — первый найденный (своих стеков нет). */
export async function readGlyphs(fontstack: string, range: string): Promise<Buffer | null> {
  for (const font of fontstack.split(',').map((item) => item.trim())) {
    if (!font) continue
    try {
      const object = await getObjectStream(basemapKeys.glyph(font, range), {
        bucket: buckets.tiles(),
      })
      const chunks: Buffer[] = []
      for await (const chunk of object.body) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    } catch (error) {
      if (!isMissingObject(error)) throw error
    }
  }
  return null
}

export async function readSprite(file: string): Promise<Buffer | null> {
  try {
    const object = await getObjectStream(basemapKeys.sprite(file), { bucket: buckets.tiles() })
    const chunks: Buffer[] = []
    for await (const chunk of object.body) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  } catch (error) {
    if (isMissingObject(error)) return null
    throw error
  }
}

// ── Загрузка сборки (`kchs basemaps upload`) ───────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.json': 'application/json',
  '.pmtiles': 'application/octet-stream',
}

function contentType(file: string): string {
  const dot = file.lastIndexOf('.')
  return CONTENT_TYPES[dot >= 0 ? file.slice(dot) : ''] ?? 'application/octet-stream'
}

async function digest(path: string, algorithm: 'md5' | 'sha256'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false
}

/** Объект уже в хранилище с тем же содержимым (ETag одиночной загрузки — MD5). */
async function unchanged(key: string, path: string, size: number): Promise<boolean> {
  try {
    const head = await headObject(key, buckets.tiles())
    if (head.ContentLength !== size) return false
    return head.ETag?.replaceAll('"', '') === (await digest(path, 'md5'))
  } catch (error) {
    if (isMissingObject(error)) return false
    throw error
  }
}

async function uploadFile(key: string, path: string): Promise<boolean> {
  const { size } = await stat(path)
  if (await unchanged(key, path, size)) return false
  await putObject(key, createReadStream(path), {
    bucket: buckets.tiles(),
    contentType: contentType(path),
    contentLength: size,
  })
  return true
}

/** Ограниченная параллельность: сотни мелких файлов шрифтов. */
async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T
      await run(item)
    }
  })
  await Promise.all(workers)
}

/** Проверка архива до загрузки: заголовок PMTiles v3, размер и SHA-256 из манифеста. */
async function verifyArchive(path: string, manifest: BasemapManifest): Promise<void> {
  const { size } = await stat(path).catch(() => {
    throw errors.validation(`Нет архива ${manifest.file} рядом с манифестом «${manifest.key}»`)
  })
  if (size !== manifest.bytes) {
    throw errors.validation(`Размер ${manifest.file} не совпадает с манифестом`)
  }
  const handle = await open(path, 'r')
  const header = Buffer.alloc(8)
  try {
    await handle.read(header, 0, 8, 0)
  } finally {
    await handle.close()
  }
  if (header.subarray(0, 7).toString('latin1') !== 'PMTiles' || header[7] !== 3) {
    throw errors.validation(`${manifest.file}: не PMTiles v3`)
  }
  if ((await digest(path, 'sha256')) !== manifest.sha256) {
    throw errors.validation(`${manifest.file}: SHA-256 не совпадает с манифестом`)
  }
}

export interface UploadSummary {
  builds: Array<{ key: string; version: string; uploaded: boolean }>
  glyphs: { uploaded: number; skipped: number }
  sprites: { uploaded: number; skipped: number }
}

/**
 * Каталог сборки `infra/basemaps/build-pmtiles.sh` → хранилище: шрифты, спрайты,
 * архивы, затем манифесты — регистрация видит только полностью загруженную сборку.
 * Неизменённые файлы пропускаются.
 */
export async function uploadBasemapBuild(
  directory: string,
  options: { key?: string; log?: (line: string) => void } = {},
): Promise<UploadSummary> {
  const log = options.log ?? (() => undefined)
  if (!(await isDirectory(directory))) throw errors.validation(`Нет каталога ${directory}`)

  const keys: string[] = []
  if (options.key) keys.push(options.key)
  else {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'glyphs' || entry.name === 'sprites') continue
      if ((await stat(join(directory, entry.name, 'manifest.json')).catch(() => null))?.isFile()) {
        keys.push(entry.name)
      }
    }
  }

  const builds: Array<{ manifest: BasemapManifest; path: string; manifestPath: string }> = []
  for (const key of keys) {
    const manifestPath = join(directory, key, 'manifest.json')
    const text = await readFile(manifestPath, 'utf8').catch(() => {
      throw errors.validation(`Нет манифеста ${manifestPath}`)
    })
    const manifest = BasemapManifest.parse(JSON.parse(text))
    if (manifest.key !== key) {
      throw errors.validation(`Ключ манифеста «${manifest.key}» не совпадает с каталогом «${key}»`)
    }
    const path = join(directory, key, manifest.file)
    await verifyArchive(path, manifest)
    builds.push({ manifest, path, manifestPath })
  }

  const glyphs = { uploaded: 0, skipped: 0 }
  const glyphRoot = join(directory, 'glyphs')
  if (await isDirectory(glyphRoot)) {
    const files: Array<{ key: string; path: string }> = []
    for (const stack of await readdir(glyphRoot, { withFileTypes: true })) {
      if (!stack.isDirectory()) continue
      for (const file of await readdir(join(glyphRoot, stack.name))) {
        const range = /^(\d+-\d+)\.pbf$/.exec(file)?.[1]
        if (range) {
          files.push({
            key: basemapKeys.glyph(stack.name, range),
            path: join(glyphRoot, stack.name, file),
          })
        }
      }
    }
    await eachLimited(files, 8, async (file) => {
      if (await uploadFile(file.key, file.path)) glyphs.uploaded += 1
      else glyphs.skipped += 1
    })
    log(`шрифты: загружено ${glyphs.uploaded}, без изменений ${glyphs.skipped}`)
  }

  const sprites = { uploaded: 0, skipped: 0 }
  const spriteRoot = join(directory, 'sprites')
  if (await isDirectory(spriteRoot)) {
    for (const file of await readdir(spriteRoot)) {
      if (!/^[a-z0-9-]+(@2x)?\.(json|png)$/.test(file)) continue
      if (await uploadFile(basemapKeys.sprite(file), join(spriteRoot, file))) sprites.uploaded += 1
      else sprites.skipped += 1
    }
    log(`спрайты: загружено ${sprites.uploaded}, без изменений ${sprites.skipped}`)
  }

  const summary: UploadSummary['builds'] = []
  for (const build of builds) {
    const { manifest } = build
    const uploaded = await uploadFile(basemapKeys.archive(manifest.key, manifest.file), build.path)
    await putObject(basemapKeys.manifest(manifest.key), await readFile(build.manifestPath), {
      bucket: buckets.tiles(),
      contentType: 'application/json',
    })
    log(
      `${manifest.key}: ${basename(build.path)} — ${uploaded ? 'загружен' : 'без изменений'}, манифест обновлён`,
    )
    summary.push({ key: manifest.key, version: manifest.version, uploaded })
  }
  return { builds: summary, glyphs, sprites }
}
