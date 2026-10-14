/**
 * Документы из файлов, выгруженных из госЭДО (ADR-0219): что станет основным файлом,
 * что приложениями. ZIP — один документ (так госсистема выгружает документ с
 * приложениями): основной — первый PDF, иначе первый DOCX, иначе первый файл. Россыпь
 * файлов — каждый отдельным документом или один документ, как выбрал делопроизводитель.
 */
export type ImportMode = 'separate' | 'single'

export interface ImportDocument {
  /** Имя для темы черновика: имя архива или основного файла. */
  name: string
  main: File
  attachments: File[]
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
  xml: 'application/xml',
  json: 'application/json',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  sig: 'application/pkcs7-signature',
  p7s: 'application/pkcs7-signature',
}

/** Не больше файлов из одного архива: выгрузка документа, а не архив дела. */
const ZIP_ENTRY_LIMIT = 100

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isZip(file: File): boolean {
  return extension(file.name) === 'zip' || file.type === 'application/zip'
}

/** Имя без расширения — тема черновика по умолчанию. */
export function baseName(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim() || name
}

/** Основной файл: PDF, затем документ Word, затем первый по порядку. */
function mainIndex(files: File[]): number {
  const rank = (file: File) => {
    const ext = extension(file.name)
    if (ext === 'pdf') return 0
    if (ext === 'docx' || ext === 'doc' || ext === 'odt' || ext === 'rtf') return 1
    // Подпись и служебные файлы выгрузки основным не бывают
    if (ext === 'sig' || ext === 'p7s' || ext === 'xml' || ext === 'json') return 3
    return 2
  }
  let best = 0
  files.forEach((file, index) => {
    if (rank(file) < rank(files[best] as File)) best = index
  })
  return best
}

function documentOf(name: string, files: File[]): ImportDocument | null {
  if (files.length === 0) return null
  const index = mainIndex(files)
  return {
    name,
    main: files[index] as File,
    attachments: files.filter((_, position) => position !== index),
  }
}

/** Файлы архива: каталоги, служебные файлы macOS и пустые записи пропускаются. */
export async function expandZip(file: File): Promise<File[]> {
  const { unzipSync } = await import('fflate')
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  return Object.entries(entries)
    .filter(
      ([path, bytes]) =>
        !path.endsWith('/') &&
        !path.startsWith('__MACOSX/') &&
        !path.split('/').pop()?.startsWith('.') &&
        bytes.byteLength > 0,
    )
    .slice(0, ZIP_ENTRY_LIMIT)
    .map(([path, bytes]) => {
      const name = path.split('/').pop() ?? path
      return new File([bytes as BlobPart], name, {
        type: MIME_BY_EXT[extension(name)] ?? 'application/octet-stream',
      })
    })
}

export async function planImport(files: File[], mode: ImportMode): Promise<ImportDocument[]> {
  const plan: ImportDocument[] = []
  const loose: File[] = []
  for (const file of files) {
    if (isZip(file)) {
      const document = documentOf(baseName(file.name), await expandZip(file))
      if (document) plan.push(document)
    } else {
      loose.push(file)
    }
  }
  if (mode === 'single') {
    const document = documentOf('', loose)
    if (document) plan.push({ ...document, name: baseName(document.main.name) })
  } else {
    for (const file of loose) plan.push({ name: baseName(file.name), main: file, attachments: [] })
  }
  return plan
}

/** SHA-256 файла в шестнадцатеричном виде — та же величина, что считает сервер. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
