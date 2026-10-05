import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import { SavedView, ViewCreateInput, ViewDefinition } from '../../views/view.js'
import {
  NamedWorkspace,
  NamedWorkspaceInput,
  NamedWorkspacePatch,
  NamedWorkspaceSummary,
} from '../../views/workspace.js'
import { IdParam } from '../params.js'

/**
 * Маршруты ядра «views» (ADR-0188). Регистрация — `apps/api/src/kernel/views/`: http.ts.
 */
export const kernelViewsRoutes = defineRoutes({
  'GET /views': {
    query: z.object({
      objectType: z.string().min(1).max(64),
      spaceId: z.uuid().optional(),
    }),
    response: { 200: z.object({ items: z.array(SavedView) }) },
  },
  'POST /views': { body: ViewCreateInput, response: { 200: SavedView } },
  'GET /views/:id': { params: IdParam, response: { 200: SavedView } },
  'PATCH /views/:id': {
    params: IdParam,
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      definition: ViewDefinition.optional(),
      pinned: z.boolean().optional(),
    }),
    response: { 200: SavedView },
  },
  'GET /workspaces': { response: { 200: z.object({ items: z.array(NamedWorkspaceSummary) }) } },
  'POST /workspaces': { body: NamedWorkspaceInput, response: { 200: NamedWorkspace } },
  'GET /workspaces/:id': { params: IdParam, response: { 200: NamedWorkspace } },
  'PATCH /workspaces/:id': {
    params: IdParam,
    body: NamedWorkspacePatch,
    response: { 200: NamedWorkspace },
  },
})
