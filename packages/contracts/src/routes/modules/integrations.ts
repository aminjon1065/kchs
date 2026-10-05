import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import { ApiTokenCreated, ApiTokenCreateInput, ApiTokenList } from '../../integrations/api-token.js'
import {
  ConfigExportInput,
  ConfigImportInput,
  ConfigImportPreview,
  ConfigImportResult,
  ConfigPackage,
  ConfigSection,
} from '../../integrations/config-package.js'
import {
  Integration,
  IntegrationCheckResult,
  IntegrationCreateInput,
  IntegrationInboundSecret,
  IntegrationList,
  IntegrationSyncList,
  IntegrationUpdateInput,
} from '../../integrations/integration.js'
import {
  Webhook,
  WebhookCreateInput,
  WebhookDeliveryList,
  WebhookList,
  WebhookSecret,
  WebhookUpdateInput,
} from '../../integrations/webhook.js'

/**
 * Маршруты модуля «integrations» (ADR-0188). Регистрация —
 * `apps/api/src/modules/integrations/http/`: config-routes.ts, integration-routes.ts,
 * token-routes.ts, webhook-routes.ts.
 */
export const integrationsRoutes = defineRoutes({
  'GET /config/sections': { response: { 200: z.object({ items: z.array(ConfigSection) }) } },
  'POST /config/export': { body: ConfigExportInput, response: { 200: ConfigPackage } },
  'POST /config/import/preview': {
    body: z.object({ package: ConfigPackage }),
    response: { 200: ConfigImportPreview },
  },
  'POST /config/import': { body: ConfigImportInput, response: { 200: ConfigImportResult } },
  'GET /integrations': { response: { 200: IntegrationList } },
  'POST /integrations': { body: IntegrationCreateInput, response: { 200: Integration } },
  'GET /integrations/:id': { params: z.object({ id: z.uuid() }), response: { 200: Integration } },
  'PATCH /integrations/:id': {
    params: z.object({ id: z.uuid() }),
    body: IntegrationUpdateInput,
    response: { 200: Integration },
  },
  'DELETE /integrations/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /integrations/:id/check': {
    params: z.object({ id: z.uuid() }),
    response: { 200: IntegrationCheckResult },
  },
  'POST /integrations/:id/inbound-secret': {
    params: z.object({ id: z.uuid() }),
    response: { 200: IntegrationInboundSecret },
  },
  'GET /integrations/:id/syncs': {
    params: z.object({ id: z.uuid() }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    response: { 200: IntegrationSyncList },
  },
  'POST /integrations/builtin/:key/check': {
    params: z.object({ key: z.string().max(40) }),
    response: { 200: IntegrationCheckResult },
  },
  'POST /hooks/:integrationId/:secret': {
    params: z.object({ integrationId: z.uuid(), secret: z.string().min(8).max(200) }),
    body: z.unknown(),
    response: { 202: z.object({ accepted: z.boolean() }) },
  },
  'GET /me/api-tokens': {
    query: z.object({ includeRevoked: z.coerce.boolean().default(false) }),
    response: { 200: ApiTokenList },
  },
  'POST /me/api-tokens': { body: ApiTokenCreateInput, response: { 200: ApiTokenCreated } },
  'DELETE /me/api-tokens/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /admin/api-tokens': {
    query: z.object({
      userId: z.uuid().optional(),
      includeRevoked: z.coerce.boolean().default(true),
    }),
    response: { 200: ApiTokenList },
  },
  'DELETE /admin/api-tokens/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /admin/api-tokens/scopes': { response: { 200: z.object({ items: z.array(z.string()) }) } },
  'GET /webhooks': { response: { 200: WebhookList } },
  'POST /webhooks': {
    body: WebhookCreateInput,
    response: { 200: z.object({ webhook: Webhook, secret: z.string() }) },
  },
  'GET /webhooks/:id': { params: z.object({ id: z.uuid() }), response: { 200: Webhook } },
  'PATCH /webhooks/:id': {
    params: z.object({ id: z.uuid() }),
    body: WebhookUpdateInput,
    response: { 200: Webhook },
  },
  'DELETE /webhooks/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /webhooks/:id/secret': {
    params: z.object({ id: z.uuid() }),
    response: { 200: WebhookSecret },
  },
  'GET /webhooks/:id/deliveries': {
    params: z.object({ id: z.uuid() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
    response: { 200: WebhookDeliveryList },
  },
  'POST /webhooks/:id/deliveries/:deliveryId/retry': {
    params: z.object({ id: z.uuid(), deliveryId: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
