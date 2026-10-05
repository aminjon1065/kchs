import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import { HelpLink, HelpPages, HelpPagesPatch } from '../../knowledge/help.js'
import {
  PageAcknowledgeInput,
  PageBlocksInput,
  PageCreateInput,
  PagePublishInput,
  PageRecord,
  PageSearchQuery,
  PageSearchResult,
  PageTreeQuery,
  PageTreeResult,
  PageUpdateInput,
  PageVersionCompareQuery,
  PageVersionCompareResult,
  PageVersionDetail,
  PageVersionInput,
  PageVersionRecord,
} from '../../knowledge/page.js'

const IdParam = z.object({ id: z.uuid() })

const VersionParams = z.object({ id: z.uuid(), versionId: z.uuid() })

/**
 * Маршруты модуля «knowledge» (ADR-0188). Регистрация —
 * `apps/api/src/modules/knowledge/http/`: routes.ts.
 */
export const knowledgeRoutes = defineRoutes({
  'GET /knowledge/help': { response: { 200: HelpLink } },
  'GET /knowledge/help/pages': { response: { 200: HelpPages } },
  'PUT /knowledge/help/pages': { body: HelpPagesPatch, response: { 200: HelpPages } },
  'POST /pages': { body: PageCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /pages/:id': { params: IdParam, response: { 200: PageRecord } },
  'PATCH /pages/:id': { params: IdParam, body: PageUpdateInput, response: { 200: PageRecord } },
  'POST /pages/:id/blocks': {
    params: IdParam,
    body: PageBlocksInput,
    response: { 200: PageRecord },
  },
  'POST /pages/:id/publish': {
    params: IdParam,
    body: PagePublishInput,
    response: { 200: PageRecord },
  },
  'GET /pages/:id/versions': {
    params: IdParam,
    response: { 200: z.object({ items: z.array(PageVersionRecord) }) },
  },
  'POST /pages/:id/versions': {
    params: IdParam,
    body: PageVersionInput,
    response: { 200: PageVersionRecord },
  },
  'GET /pages/:id/versions/compare': {
    params: IdParam,
    query: PageVersionCompareQuery,
    response: { 200: PageVersionCompareResult },
  },
  'GET /pages/:id/versions/:versionId': {
    params: VersionParams,
    response: { 200: PageVersionDetail },
  },
  'POST /pages/:id/versions/:versionId/restore': {
    params: VersionParams,
    response: { 200: PageVersionRecord },
  },
  'POST /pages/:id/acknowledgments': {
    params: IdParam,
    body: PageAcknowledgeInput,
    response: {
      200: z.object({ requested: z.number().int(), skipped: z.number().int() }),
    },
  },
  'GET /knowledge/tree': { query: PageTreeQuery, response: { 200: PageTreeResult } },
  'GET /knowledge/search': { query: PageSearchQuery, response: { 200: PageSearchResult } },
})
