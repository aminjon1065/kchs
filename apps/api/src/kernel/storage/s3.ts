import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
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

export function s3(): S3Client {
  if (client) return client
  const env = config()
  client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  })
  return client
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
  const url = await getSignedUrl(s3(), command, { expiresIn: options.ttl ?? SIGNED_URL_TTL })
  return rewritePublicEndpoint(url)
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
  const url = await getSignedUrl(s3(), command, { expiresIn: options.ttl ?? SIGNED_URL_TTL })
  return rewritePublicEndpoint(url)
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
    const url = await getSignedUrl(s3(), command, { expiresIn: 3600 * 6 })
    partUrls.push({
      partNumber,
      url: rewritePublicEndpoint(url),
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

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string,
  bucket?: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket ?? buckets.files(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

export async function getObjectBuffer(key: string, bucket?: string): Promise<Buffer> {
  const result = await s3().send(
    new GetObjectCommand({ Bucket: bucket ?? buckets.files(), Key: key }),
  )
  const chunks: Uint8Array[] = []
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export async function deleteObject(key: string, bucket?: string): Promise<void> {
  await s3()
    .send(new DeleteObjectCommand({ Bucket: bucket ?? buckets.files(), Key: key }))
    .catch(() => undefined)
}

/** Внутренний адрес MinIO заменяется публичным для ссылок в браузере. */
function rewritePublicEndpoint(url: string): string {
  const env = config()
  if (!env.S3_PUBLIC_ENDPOINT) return url
  return url.replace(env.S3_ENDPOINT, env.S3_PUBLIC_ENDPOINT)
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
