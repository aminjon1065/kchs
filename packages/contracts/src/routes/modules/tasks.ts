import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import {
  ControlExportQuery,
  ControlList,
  ControlListQuery,
  ControlMetricsSetupInput,
  ControlMetricsState,
  ControlQuery,
  ControlReport,
  IssuedSummary,
  TaskSettings,
  TeamSummary,
  WorkloadQuery,
  WorkloadReport,
} from '../../tasks/control.js'
import {
  ProjectCreateInput,
  ProjectListQuery,
  ProjectRecord,
  ProjectUpdateInput,
} from '../../tasks/project.js'
import {
  TaskSeriesCreateInput,
  TaskSeriesList,
  TaskSeriesPatch,
  TaskSeriesRecord,
} from '../../tasks/series.js'
import {
  TaskBulkInput,
  TaskBulkResult,
  TaskCancelInput,
  TaskChecklistAddInput,
  TaskChecklistPatchInput,
  TaskCreateInput,
  TaskExtensionDecisionInput,
  TaskExtensionRequestInput,
  TaskList,
  TaskListQuery,
  TaskReassignInput,
  TaskRecord,
  TaskReportInput,
  TaskReturnInput,
  TaskStatusInput,
  TaskSubtaskCreateInput,
  TaskSummary,
  TaskUpdateInput,
} from '../../tasks/task.js'
import { IdParam } from '../params.js'

const SourceQuery = z.object({ objectId: z.uuid() })

const RowSourceQuery = z.object({
  datasetId: z.uuid(),
  rowId: z.string().regex(/^\d{1,18}$/),
})

const ChecklistItemParams = z.object({ id: z.uuid(), itemId: z.uuid() })

/**
 * Маршруты модуля «tasks» (ADR-0188). Регистрация — `apps/api/src/modules/tasks/`: module.ts.
 */
export const tasksRoutes = defineRoutes({
  'GET /tasks': { query: TaskListQuery, response: { 200: TaskList } },
  'GET /tasks/summary': { response: { 200: TaskSummary } },
  'GET /tasks/control': { query: ControlQuery, response: { 200: ControlReport } },
  'GET /tasks/control/list': { query: ControlListQuery, response: { 200: ControlList } },
  'GET /tasks/control/export': {
    query: ControlExportQuery.extend({
      view: z.enum(['matrix', 'list']).default('matrix'),
      bucket: ControlListQuery.shape.bucket,
      row: ControlListQuery.shape.row,
    }),
  },
  'GET /tasks/workload': { query: WorkloadQuery, response: { 200: WorkloadReport } },
  'GET /tasks/issued': { response: { 200: IssuedSummary } },
  'GET /tasks/team': { response: { 200: TeamSummary } },
  'GET /tasks/settings': { response: { 200: TaskSettings } },
  'PUT /admin/tasks/settings': { body: TaskSettings, response: { 200: TaskSettings } },
  'GET /admin/tasks/metrics': { response: { 200: ControlMetricsState } },
  'POST /admin/tasks/metrics': {
    body: ControlMetricsSetupInput,
    response: { 200: ControlMetricsState },
  },
  'GET /tasks/by-source': { query: SourceQuery, response: { 200: TaskList } },
  'GET /tasks/by-row': { query: RowSourceQuery, response: { 200: TaskList } },
  'POST /tasks': { body: TaskCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /tasks/:id': { params: IdParam, response: { 200: TaskRecord } },
  'PATCH /tasks/:id': { params: IdParam, body: TaskUpdateInput, response: { 200: TaskRecord } },
  'POST /tasks/:id/status': {
    params: IdParam,
    body: TaskStatusInput,
    response: { 200: TaskRecord },
  },
  'POST /tasks/:id/start': { params: IdParam, response: { 200: TaskRecord } },
  'POST /tasks/:id/report': {
    params: IdParam,
    body: TaskReportInput,
    response: { 200: TaskRecord },
  },
  'POST /tasks/:id/accept': { params: IdParam, response: { 200: TaskRecord } },
  'POST /tasks/:id/return': {
    params: IdParam,
    body: TaskReturnInput,
    response: { 200: TaskRecord },
  },
  'POST /tasks/:id/reassign': {
    params: IdParam,
    body: TaskReassignInput,
    response: { 200: TaskRecord },
  },
  'POST /tasks/:id/extension': {
    params: IdParam,
    body: TaskExtensionRequestInput,
    response: { 200: TaskRecord },
  },
  'POST /tasks/:id/extension/decide': {
    params: IdParam,
    body: TaskExtensionDecisionInput,
    response: { 200: TaskRecord },
  },
  'POST /tasks/:id/cancel': {
    params: IdParam,
    body: TaskCancelInput,
    response: { 200: TaskRecord },
  },
  'POST /tasks/bulk': { body: TaskBulkInput, response: { 200: TaskBulkResult } },
  'GET /task-series': { response: { 200: TaskSeriesList } },
  'POST /task-series': { body: TaskSeriesCreateInput, response: { 200: TaskSeriesRecord } },
  'GET /task-series/:id': { params: IdParam, response: { 200: TaskSeriesRecord } },
  'PATCH /task-series/:id': {
    params: IdParam,
    body: TaskSeriesPatch,
    response: { 200: TaskSeriesRecord },
  },
  'POST /task-series/:id/pause': { params: IdParam, response: { 200: TaskSeriesRecord } },
  'POST /task-series/:id/resume': { params: IdParam, response: { 200: TaskSeriesRecord } },
  'POST /task-series/:id/stop': { params: IdParam, response: { 200: TaskSeriesRecord } },
  'POST /tasks/:id/checklist': {
    params: IdParam,
    body: TaskChecklistAddInput,
    response: { 200: TaskRecord },
  },
  'PATCH /tasks/:id/checklist/:itemId': {
    params: ChecklistItemParams,
    body: TaskChecklistPatchInput,
    response: { 200: TaskRecord },
  },
  'DELETE /tasks/:id/checklist/:itemId': {
    params: ChecklistItemParams,
    response: { 200: TaskRecord },
  },
  'POST /tasks/:id/subtasks': {
    params: IdParam,
    body: TaskSubtaskCreateInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /projects': {
    query: ProjectListQuery,
    response: { 200: z.object({ items: z.array(ProjectRecord) }) },
  },
  'POST /projects': { body: ProjectCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /projects/:id': { params: IdParam, response: { 200: ProjectRecord } },
  'PATCH /projects/:id': {
    params: IdParam,
    body: ProjectUpdateInput,
    response: { 200: ProjectRecord },
  },
})
