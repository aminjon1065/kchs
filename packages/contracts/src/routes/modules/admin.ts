import { z } from 'zod'
import { BackupList, BackupRecord } from '../../admin/backups.js'
import { Branding, BrandingPatch } from '../../admin/branding.js'
import { FeatureFlagList, FeatureFlagPatch } from '../../admin/features.js'
import { HealthReport } from '../../admin/org.js'
import { defineRoutes } from '../../http/route-contract.js'
import { AuditActionCatalog, AuditEntry } from '../../objects/activity.js'

/**
 * Маршруты модуля «admin» (ADR-0188). Регистрация — `apps/api/src/modules/admin/`:
 * http/backup-routes.ts, http/branding-routes.ts, http/features-routes.ts, module.ts.
 */
export const adminRoutes = defineRoutes({
  'GET /admin/backups': { response: { 200: BackupList } },
  'POST /admin/backups': { response: { 200: BackupRecord } },
  'POST /admin/backups/:id/verified': {
    params: z.object({ id: z.uuid() }),
    body: z.object({ note: z.string().max(500).default('') }),
    response: { 200: BackupRecord },
  },
  'POST /admin/maintenance/reindex': { response: { 200: z.object({ jobId: z.uuid() }) } },
  'GET /branding': { response: { 200: Branding } },
  'PATCH /admin/branding': { body: BrandingPatch, response: { 200: Branding } },
  'GET /admin/features': { response: { 200: FeatureFlagList } },
  'PATCH /admin/features/:key': {
    params: z.object({ key: z.string().min(1).max(64) }),
    body: FeatureFlagPatch,
    response: { 200: FeatureFlagList },
  },
  'GET /admin/audit': {
    query: z.object({
      actorId: z.uuid().optional(),
      action: z.string().max(100).optional(),
      objectId: z.uuid().optional(),
      severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
    response: {
      200: z.object({ items: z.array(AuditEntry), nextCursor: z.string().nullable() }),
    },
  },
  'GET /admin/audit/actions': { response: { 200: AuditActionCatalog } },
  'GET /admin/audit/export.csv': {
    query: z.object({
      actorId: z.uuid().optional(),
      action: z.string().max(100).optional(),
      objectId: z.uuid().optional(),
      severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  },
  'GET /admin/health': { response: { 200: HealthReport } },
  'POST /admin/engine/echo': {
    body: z.object({ message: z.string().max(200).default('ping') }),
    response: { 200: z.object({ jobId: z.uuid() }) },
  },
  'GET /admin/jobs': {},
})
