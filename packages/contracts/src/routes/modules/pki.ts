import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import {
  PkiAdminCertificateQuery,
  PkiCertificateList,
  PkiCertificateRecord,
  PkiChallenge,
  PkiChallengeInput,
  PkiEnrollInput,
  PkiRevokeInput,
  PkiRotateInput,
  PkiStatus,
} from '../../pki/pki.js'
import { IdParam } from '../params.js'

const PkiGenerationParams = z.object({ generation: z.string().regex(/^[0-9a-f]{16}$/) })

/**
 * Маршруты модуля «pki» — УЦ Комитета (ADR-0218). Регистрация —
 * `apps/api/src/modules/pki/http/routes.ts`. Корневой и выпускающий сертификаты, списки
 * отзыва и ответчик OCSP открыты и через шлюз DMZ: подпись проверяют вне Комитета.
 * Служба штампов времени — только внутри: её зовёт движок.
 */
export const pkiRoutes = defineRoutes({
  'GET /pki/status': { response: { 200: PkiStatus } },
  'GET /pki/root.crt': { exposure: 'public' },
  'GET /pki/issuing.crt': { exposure: 'public' },
  'GET /pki/root.crl': { exposure: 'public' },
  'GET /pki/issuing.crl': { exposure: 'public' },
  // Выпускающие после смены ключа (ADR-0224): адреса вшиты в выпущенные ими сертификаты
  'GET /pki/issuers/:generation.crt': { params: PkiGenerationParams, exposure: 'public' },
  'GET /pki/issuers/:generation.crl': { params: PkiGenerationParams, exposure: 'public' },
  'POST /pki/ocsp': { exposure: 'public' },
  'GET /pki/ocsp/:request': {
    params: z.object({ request: z.string().min(1).max(4096) }),
    exposure: 'public',
  },
  'POST /pki/tsa': {},
  'POST /me/certificates/challenge': {
    body: PkiChallengeInput,
    response: { 200: PkiChallenge },
  },
  'POST /me/certificates': { body: PkiEnrollInput, response: { 200: PkiCertificateRecord } },
  'GET /me/certificates': { response: { 200: PkiCertificateList } },
  'POST /me/certificates/:id/revoke': {
    params: IdParam,
    body: PkiRevokeInput,
    response: { 200: PkiCertificateRecord },
  },
  'POST /admin/pki/init': { response: { 200: PkiStatus } },
  'POST /admin/pki/rotate': { body: PkiRotateInput, response: { 200: PkiStatus } },
  'GET /admin/pki/certificates': {
    query: PkiAdminCertificateQuery,
    response: { 200: PkiCertificateList },
  },
  'POST /admin/pki/certificates/:id/revoke': {
    params: IdParam,
    body: PkiRevokeInput,
    response: { 200: PkiCertificateRecord },
  },
})
