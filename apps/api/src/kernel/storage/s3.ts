import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
