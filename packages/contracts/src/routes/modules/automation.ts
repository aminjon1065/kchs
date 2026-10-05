import { z } from 'zod'
import {
  ManualRuleList,
  ManualRulesQuery,
  RuleCatalog,
  RuleCreateInput,
  RuleDryRunInput,
  RuleDryRunResult,
  RuleEnabledInput,
  RuleExport,
  RuleImportInput,
  RuleList,
  RuleListQuery,
  RuleRecord,
  RuleRunList,
  RuleRunListQuery,
  RuleRunNowInput,
  RuleRunRecord,
  RuleRunStarted,
  RuleTemplateList,
  RuleUpdateInput,
  RuleValidateInput,
  RuleValidateResult,
  RuleVersionList,
} from '../../automation/api.js'
import { defineRoutes } from '../../http/route-contract.js'

const IdParam = z.object({ id: z.uuid() })

const Ok = z.object({ ok: z.boolean() })

/**
 * Маршруты модуля «automation» (ADR-0188). Регистрация — `apps/api/src/modules/automation/`:
 * http.ts.
 */
export const automationRoutes = defineRoutes({
  'GET /automation/rules': { query: RuleListQuery, response: { 200: RuleList } },
  'POST /automation/rules': {
    body: RuleCreateInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /automation/rules/:id': { params: IdParam, response: { 200: RuleRecord } },
  'PUT /automation/rules/:id': {
    params: IdParam,
    body: RuleUpdateInput,
    response: { 200: RuleRecord },
  },
  'POST /automation/rules/:id/enabled': {
    params: IdParam,
    body: RuleEnabledInput,
    response: { 200: RuleRecord },
  },
  'POST /automation/rules/:id/duplicate': {
    params: IdParam,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /automation/rules/:id/versions': { params: IdParam, response: { 200: RuleVersionList } },
  'POST /automation/rules/:id/versions/:versionId/restore': {
    params: z.object({ id: z.uuid(), versionId: z.uuid() }),
    response: { 200: RuleRecord },
  },
  'GET /automation/rules/:id/export': { params: IdParam, response: { 200: RuleExport } },
  'POST /automation/rules/import': {
    body: RuleImportInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'POST /automation/rules/validate': {
    body: RuleValidateInput,
    response: { 200: RuleValidateResult },
  },
  'POST /automation/rules/dry-run': { body: RuleDryRunInput, response: { 200: RuleDryRunResult } },
  'GET /automation/rules/:id/runs': {
    params: IdParam,
    query: RuleRunListQuery,
    response: { 200: RuleRunList },
  },
  'GET /automation/runs/:id': { params: IdParam, response: { 200: RuleRunRecord } },
  'POST /automation/rules/:id/run': {
    params: IdParam,
    body: RuleRunNowInput,
    response: { 200: RuleRunStarted },
  },
  'GET /automation/manual-rules': { query: ManualRulesQuery, response: { 200: ManualRuleList } },
  'GET /automation/templates': { response: { 200: RuleTemplateList } },
  'GET /automation/catalog': { response: { 200: RuleCatalog } },
  'POST /hooks/rules/:id/:token': {
    params: z.object({ id: z.uuid(), token: z.string().min(16).max(64) }),
    body: z.record(z.string(), z.unknown()).optional(),
    response: { 200: Ok },
  },
})
