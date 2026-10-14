import type { PkiRotationMode, PkiStatus } from '@kchs/contracts'
import { PkiAuthority } from '~/modules/pki/public.js'
import { systemCtx } from '~/shared/context.js'
import { runMigrations } from '~/shared/db/migrate.js'

/**
 * `kchs pki rotate` (ADR-0224): смена ключа выпускающего УЦ Комитета. Плановая — перед
 * концом срока; `--compromise` — прежний выпускающий отзывается корнем, сертификаты
 * сотрудников перевыпускаются при следующем подписании. Прежние подписи проверяются:
 * цепочка и список отзыва прежнего выпускающего остаются опубликованными.
 */
export async function runPkiRotate(input: {
  mode: PkiRotationMode
  reason: string
}): Promise<PkiStatus> {
  await runMigrations()
  return PkiAuthority.rotate(systemCtx('kchs-pki-rotate'), input)
}

export function formatPkiRotation(status: PkiStatus): string {
  const [current, ...retired] = status.issuers
  const lines = [
    'Ключ выпускающего УЦ Комитета сменён.',
    `  новый выпускающий: ${current?.fingerprint ?? '—'} (до ${current?.notAfter.slice(0, 10) ?? '—'})`,
    `  адреса: /api/v1/pki/${current?.path ?? 'issuing'}.crt и .crl`,
    ...retired.map(
      (item) =>
        `  прежний: ${item.fingerprint} — ${item.revokedAt ? 'отозван корнем' : 'список отзыва публикуется дальше'}`,
    ),
    `  корень не менялся: ${status.rootFingerprint ?? '—'}`,
  ]
  return `${lines.join('\n')}\n`
}
