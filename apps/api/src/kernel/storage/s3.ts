import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from '~/shared/config/index.js'

let client: S3Client | null = null
let presigner: S3Client | null = null

function createClient(endpoint: string): S3Client {
  const env = config()
  return new S3Client({
    endpoint,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  })
}

export function s3(): S3Client {
  client ??= createClient(config().S3_ENDPOINT)
  return client
}

/**
 * Клиент для подписанных ссылок браузеру. SigV4 подписывает заголовок Host,
 * поэтому ссылку нужно подписывать сразу публичным адресом хранилища: замена
 * адреса после подписи ломала подпись — в контейнерах api ходит в minio:9000,
 * а браузер в опубликованный порт. Подпись считается локально, без обращения
 * к публичному адресу.
 */
function presignClient(): S3Client {
  const env = config()
  if (!env.S3_PUBLIC_ENDPOINT || env.S3_PUBLIC_ENDPOINT === env.S3_ENDPOINT) return s3()
  presigner ??= createClient(env.S3_PUBLIC_ENDPOINT)
  return presigner
}

export const buckets = {
  files: () => config().S3_BUCKET_FILES,
  previews: () => config().S3_BUCKET_PREVIEWS,
  media: () => config().S3_BUCKET_MEDIA,
  exports: () => config().S3_BUCKET_EXPORTS,
  tiles: () => config().S3_BUCKET_TILES,
  /** Резервные копии базы (15-admin-operations.md §5). */
  backups: () => config().S3_BUCKET_BACKUPS,
}

/** Ключ хранения: spaces/{spaceId}/files/{fileId}/{versionId}/{safeName} (09-files.md §2). */
export function storageKey(
  spaceId: string,
  fileId: string,
  versionId: string,
  filename: string,
): string {
  return `spaces/${spaceId}/files/${fileId}/${versionId}/${safeName(filename)}`
}

export function safeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

const SIGNED_URL_TTL = 900

export async function signedGetUrl(
  key: string,
  options: { bucket?: string; filename?: string; inline?: boolean; ttl?: number } = {},
): Promise<string> {
  const disposition = options.filename
    ? `${options.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(options.filename)}`
    : undefined
  const command = new GetObjectCommand({
    Bucket: options.bucket ?? buckets.files(),
    Key: key,
    ResponseContentDisposition: disposition,
  })
  return getSignedUrl(presignClient(), command, { expiresIn: options.ttl ?? SIGNED_URL_TTL })
}

export async function signedPutUrl(
  key: string,
  options: { bucket?: string; contentType?: string; ttl?: number } = {},
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: options.bucket ?? buckets.files(),
    Key: key,
    ContentType: options.contentType,
  })
  return getSignedUrl(presignClient(), command, { expiresIn: options.ttl ?? SIGNED_URL_TTL })
}

export interface MultipartInit {
  uploadId: string
  partUrls: Array<{ partNumber: number; url: string; size: number }>
  partSize: number
}

const PART_SIZE = 16 * 1024 * 1024

/** Инициирует multipart-загрузку и подписывает URL всех частей (докачка возможна). */
export async function initMultipart(
  key: string,
  size: number,
  contentType: string,
): Promise<MultipartInit> {
  const result = await s3().send(
    new CreateMultipartUploadCommand({
      Bucket: buckets.files(),
      Key: key,
      ContentType: contentType,
    }),
  )
  const uploadId = result.UploadId!
  const partCount = Math.max(1, Math.ceil(size / PART_SIZE))
  const partUrls: MultipartInit['partUrls'] = []

  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const command = new UploadPartCommand({
      Bucket: buckets.files(),
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    })
    const url = await getSignedUrl(presignClient(), command, { expiresIn: 3600 * 6 })
    partUrls.push({
      partNumber,
      url,
      size: partNumber === partCount ? size - PART_SIZE * (partCount - 1) : PART_SIZE,
    })
  }

  return { uploadId, partUrls, partSize: PART_SIZE }
}

/**
 * Бакет существует: у установки, поднятой до появления бакета (копии базы),
 * его может не быть, а создавать его руками — лишний шаг в runbook.
 */
export async function ensureBucket(bucket: string): Promise<void> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status !== 404 && status !== 403) throw error
    await s3().send(new CreateBucketCommand({ Bucket: bucket }))
  }
}

/**
 * Поток, длина которого заранее неизвестна (дамп базы): части по `partSize`
 * уходят multipart-загрузкой. Обычный `putObject` так не умеет — подписи S3
 * нужен `Content-Length`, а у потока его нет. Возвращает размер объекта.
 */
export async function putStream(
  key: string,
  body: Readable,
  options: { bucket?: string; contentType?: string; partSize?: number } = {},
): Promise<number> {
  const Bucket = options.bucket ?? buckets.files()
  const partSize = Math.max(5 * 1024 * 1024, options.partSize ?? PART_SIZE)
  const created = await s3().send(
    new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: options.contentType }),
  )
  const uploadId = created.UploadId!
  const parts: Array<{ PartNumber: number; ETag: string }> = []
  let buffered: Buffer[] = []
  let bufferedBytes = 0
  let total = 0

  const flush = async (): Promise<void> => {
    if (bufferedBytes === 0) return
    const part = Buffer.concat(buffered, bufferedBytes)
    buffered = []
    bufferedBytes = 0
    const uploaded = await s3().send(
      new UploadPartCommand({
        Bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: parts.length + 1,
        Body: part,
        ContentLength: part.byteLength,
      }),
    )
    parts.push({ PartNumber: parts.length + 1, ETag: uploaded.ETag! })
  }

  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      buffered.push(buffer)
      bufferedBytes += buffer.byteLength
      total += buffer.byteLength
      if (bufferedBytes >= partSize) await flush()
    }
    await flush()
    // Пустой поток — тоже объект: S3 требует хотя бы одну часть
    if (parts.length === 0) {
      buffered = [Buffer.alloc(0)]
      bufferedBytes = 0
      await s3()
        .send(
          new UploadPartCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: 1,
            Body: Buffer.alloc(0),
            ContentLength: 0,
          }),
        )
        .then((uploaded) => parts.push({ PartNumber: 1, ETag: uploaded.ETag! }))
    }
    await s3().send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    )
    return total
  } catch (error) {
    await s3()
      .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
      .catch(() => undefined)
    throw error
  }
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: buckets.files(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  )
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await s3()
    .send(
      new AbortMultipartUploadCommand({ Bucket: buckets.files(), Key: key, UploadId: uploadId }),
    )
    .catch(() => undefined)
}

export async function headObject(key: string, bucket?: string) {
  return s3().send(new HeadObjectCommand({ Bucket: bucket ?? buckets.files(), Key: key }))
}

/** Серверная копия объекта внутри бакета (одним запросом S3 — до 5 ГБ). */
export async function copyObject(sourceKey: string, targetKey: string, bucket?: string) {
  const target = bucket ?? buckets.files()
  const source = sourceKey.split('/').map(encodeURIComponent).join('/')
  return s3().send(
    new CopyObjectCommand({ Bucket: target, Key: targetKey, CopySource: `${target}/${source}` }),
  )
}

/** Небольшой текстовый объект целиком (манифесты, отчёты движка). */
export async function readObjectText(key: string, bucket?: string): Promise<string> {
  const response = await s3().send(
    new GetObjectCommand({ Bucket: bucket ?? buckets.files(), Key: key }),
  )
  return (await response.Body?.transformToString('utf-8')) ?? ''
}

/**
 * Объект потоком — целиком или диапазоном байтов (`bytes=a-b`): ответ клиенту
 * без буферизации в памяти (PMTiles, 07-gis-engine.md §5).
 */
export async function getObjectStream(
  key: string,
  options: { bucket?: string; range?: string } = {},
): Promise<{
  body: Readable
  contentLength: number | null
  contentRange: string | null
  contentType: string | null
  etag: string | null
}> {
  const response = await s3().send(
    new GetObjectCommand({
      Bucket: options.bucket ?? buckets.files(),
      Key: key,
      Range: options.range,
    }),
  )
  return {
    body: response.Body as Readable,
    contentLength: response.ContentLength ?? null,
    contentRange: response.ContentRange ?? null,
    contentType: response.ContentType ?? null,
    etag: response.ETag ?? null,
  }
}

/** Запись объекта одним запросом (до 5 ГБ): буфер или поток файла. */
export async function putObject(
  key: string,
  body: Buffer | Readable,
  options: { bucket?: string; contentType?: string; contentLength?: number } = {},
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: options.bucket ?? buckets.files(),
      Key: key,
      Body: body,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    }),
  )
}

/** Объекты с префиксом — постранично, целиком (каталоги сборок и кэшей, не пользовательские файлы). */
export async function listObjects(
  prefix: string,
  bucket?: string,
): Promise<Array<{ key: string; size: number; etag: string | null }>> {
  const items: Array<{ key: string; size: number; etag: string | null }> = []
  let token: string | undefined
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucket ?? buckets.files(),
        Prefix: prefix,
        ContinuationToken: token,
      }),
    )
    for (const item of page.Contents ?? []) {
      if (item.Key) items.push({ key: item.Key, size: item.Size ?? 0, etag: item.ETag ?? null })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return items
}

/** Удаляет все объекты с префиксом (пачками по 1000); возвращает их число. */
export async function deletePrefix(prefix: string, bucket?: string): Promise<number> {
  const target = bucket ?? buckets.files()
  const keys = (await listObjects(prefix, target)).map((item) => item.key)
  for (let start = 0; start < keys.length; start += 1000) {
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: target,
        Delete: { Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    )
  }
  return keys.length
}

/** Ошибка S3 «нет такого объекта» (GET — NoSuchKey, HEAD — NotFound). */
export function isMissingObject(error: unknown): boolean {
  const name = (error as { name?: string }).name
  return name === 'NoSuchKey' || name === 'NotFound'
}

export async function deleteObject(key: string, bucket?: string): Promise<void> {
  await s3()
    .send(new DeleteObjectCommand({ Bucket: bucket ?? buckets.files(), Key: key }))
    .catch(() => undefined)
}

export async function storageHealthy(): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: buckets.files(), Key: '__healthcheck__' }))
    return true
  } catch (error) {
    // 404 означает, что бакет доступен, а объекта нет — это здоровое состояние
    const code = (error as { name?: string }).name
    return code === 'NotFound' || code === 'NoSuchKey'
  }
}
