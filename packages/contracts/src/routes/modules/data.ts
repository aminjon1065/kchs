import { z } from 'zod'
import {
  AnalysisCreateInput,
  AnalysisPreviewInput,
  AnalysisRecord,
  AnalysisRunStarted,
} from '../../data/analysis.js'
import { AskDataInput, AskDataResult } from '../../data/ask.js'
import {
  ChartCreateInput,
  ChartDataInput,
  ChartRecord,
  ChartUpdateInput,
} from '../../data/chart.js'
import {
  ColumnarAdmin,
  ColumnarCopy,
  ColumnarSettings,
  ColumnarSettingsPatch,
} from '../../data/columnar.js'
import {
  DashboardCreateInput,
  DashboardData,
  DashboardDataInput,
  DashboardDrillInput,
  DashboardDrillResult,
  DashboardRecord,
  DashboardUpdateInput,
} from '../../data/dashboard.js'
import {
  DatasetCreateInput,
  DatasetFieldConvertInput,
  DatasetFieldConvertReport,
  DatasetFieldInput,
  DatasetFieldPatch,
  DatasetRecord,
  DatasetRow,
  DatasetRowHistoryEntry,
  DatasetRowPatch,
  DatasetRowsBatch,
  DatasetRowsBatchQueued,
  DatasetRowsBatchResult,
  DatasetRowsDelete,
  DatasetRowsInsert,
  DatasetRowsQuery,
  DatasetUpdateInput,
  DatasetVersion,
  FieldProfile,
} from '../../data/dataset.js'
import {
  DashboardTileExportInput,
  DatasetExportDownload,
  DatasetExportInput,
  DatasetExportStarted,
  QueryExportInput,
} from '../../data/export.js'
import {
  ImportAnalysis,
  ImportAnalyzeInput,
  ImportRecord,
  ImportRunInput,
} from '../../data/import.js'
import {
  MetricCreateInput,
  MetricRecord,
  MetricUpdateInput,
  MetricValue,
  MetricValueInput,
} from '../../data/metric.js'
import { NotebookCellsInput, NotebookCreateInput, NotebookRecord } from '../../data/notebook.js'
import {
  PipelineCreateInput,
  PipelineList,
  PipelinePreviewInput,
  PipelineRecord,
  PipelineRunList,
  PipelineRunStarted,
  PipelineUpdateInput,
  PipelineValidateInput,
  PipelineValidateResult,
} from '../../data/pipeline.js'
import {
  DatasetColumnPolicy,
  DatasetColumnPolicyInput,
  DatasetColumnPolicyPatch,
  DatasetPolicies,
  DatasetRowPolicy,
  DatasetRowPolicyInput,
  DatasetRowPolicyPatch,
} from '../../data/policy.js'
import { DatasetQuality, QualityRulesInput } from '../../data/quality.js'
import {
  QueryResult,
  QueryRunInput,
  SYSTEM_DATASETS,
  SystemDatasetSchema,
} from '../../data/query.js'
import {
  FeedPreview,
  FeedPreviewInput,
  FeedSourceCreateInput,
  SourceCreateInput,
  SourceList,
  SourcePreview,
  SourcePreviewInput,
  SourceRecord,
  SourceRunList,
  SourceRunStarted,
  SourceTableList,
  SourceUpdateInput,
} from '../../data/source.js'
import { SqlRunInput, SqlSchema } from '../../data/sql.js'
import { ENGINE_CALLBACKS } from '../../engine/callbacks.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IntegrationCheckResult } from '../../integrations/integration.js'
import { IdParam, RowParams } from '../params.js'

const FieldParams = z.object({ id: z.uuid(), key: z.string().min(1).max(64) })

const PolicyParams = z.object({ id: z.uuid(), policyId: z.uuid() })

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })

const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) })

const IntegrationParam = z.object({ integrationId: z.uuid() })

/**
 * Маршруты модуля «data» (ADR-0188). Регистрация — `apps/api/src/modules/data/`:
 * analysis-module.ts, export-module.ts, module.ts, notebook-module.ts, pipeline-module.ts,
 * source-module.ts.
 */
export const dataRoutes = defineRoutes({
  'POST /analyses': { body: AnalysisCreateInput, response: { 200: AnalysisRecord } },
  'POST /analyses/preview': { body: AnalysisPreviewInput, response: { 200: QueryResult } },
  'GET /analyses/:id': { params: IdParam, response: { 200: AnalysisRecord } },
  'POST /analyses/:id/run': { params: IdParam, response: { 200: AnalysisRunStarted } },
  'POST /queries/export': { body: QueryExportInput },
  'POST /dashboards/:id/export': { params: IdParam, body: DashboardTileExportInput },
  'POST /datasets': { body: DatasetCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /datasets/:id/quality': { params: IdParam, response: { 200: DatasetQuality } },
  'GET /datasets/:id/columnar': { params: IdParam, response: { 200: ColumnarCopy } },
  'POST /datasets/:id/columnar/build': { params: IdParam, response: { 200: ColumnarCopy } },
  'GET /admin/data/columnar': { response: { 200: ColumnarAdmin } },
  'PUT /admin/data/columnar/settings': {
    body: ColumnarSettingsPatch,
    response: { 200: ColumnarSettings },
  },
  'PUT /datasets/:id/quality/rules': {
    params: IdParam,
    body: QualityRulesInput,
    response: { 200: DatasetQuality },
  },
  'POST /datasets/:id/quality/run': { params: IdParam, response: { 200: DatasetQuality } },
  'GET /datasets/:id': { params: IdParam, response: { 200: DatasetRecord } },
  'GET /datasets/:id/fields/:key/profile': { params: FieldParams, response: { 200: FieldProfile } },
  'PATCH /datasets/:id': {
    params: IdParam,
    body: DatasetUpdateInput,
    response: { 200: DatasetRecord },
  },
  'POST /datasets/:id/fields': {
    params: IdParam,
    body: DatasetFieldInput,
    response: { 200: DatasetRecord },
  },
  'PATCH /datasets/:id/fields/:key': {
    params: FieldParams,
    body: DatasetFieldPatch,
    response: { 200: DatasetRecord },
  },
  'POST /datasets/:id/fields/:key/convert': {
    params: FieldParams,
    body: DatasetFieldConvertInput,
    response: { 200: DatasetFieldConvertReport },
  },
  'DELETE /datasets/:id/fields/:key': { params: FieldParams, response: { 200: DatasetRecord } },
  'GET /sql/schema': { response: { 200: SqlSchema } },
  'POST /sql/run': { body: SqlRunInput, response: { 200: QueryResult } },
  'POST /datasets/:id/exports': {
    params: IdParam,
    body: DatasetExportInput,
    response: { 200: DatasetExportStarted },
  },
  'GET /datasets/exports/:jobId/download': {
    params: z.object({ jobId: z.uuid() }),
    response: { 200: DatasetExportDownload },
  },
  'POST /datasets/:id/versions/:number/rollback': {
    params: z.object({ id: z.uuid(), number: z.coerce.number().int().min(1) }),
    response: { 200: DatasetVersion },
  },
  'GET /datasets/:id/policies': { params: IdParam, response: { 200: DatasetPolicies } },
  'POST /datasets/:id/policies/rows': {
    params: IdParam,
    body: DatasetRowPolicyInput,
    response: { 200: DatasetRowPolicy },
  },
  'PATCH /datasets/:id/policies/rows/:policyId': {
    params: PolicyParams,
    body: DatasetRowPolicyPatch,
    response: { 200: DatasetRowPolicy },
  },
  'DELETE /datasets/:id/policies/rows/:policyId': {
    params: PolicyParams,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /datasets/:id/policies/columns': {
    params: IdParam,
    body: DatasetColumnPolicyInput,
    response: { 200: DatasetColumnPolicy },
  },
  'PATCH /datasets/:id/policies/columns/:policyId': {
    params: PolicyParams,
    body: DatasetColumnPolicyPatch,
    response: { 200: DatasetColumnPolicy },
  },
  'DELETE /datasets/:id/policies/columns/:policyId': {
    params: PolicyParams,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /queries/run': { body: QueryRunInput, response: { 200: QueryResult } },
  'POST /datasets/:id/ask': {
    params: IdParam,
    body: AskDataInput,
    response: { 200: AskDataResult },
  },
  'POST /datasets/:id/rows/query': {
    params: IdParam,
    body: DatasetRowsQuery,
    response: { 200: QueryResult },
  },
  'POST /datasets/:id/rows': {
    params: IdParam,
    body: DatasetRowsInsert,
    response: { 200: z.object({ items: z.array(DatasetRow) }) },
  },
  'POST /datasets/:id/rows/batch': {
    params: IdParam,
    body: DatasetRowsBatch,
    response: { 200: DatasetRowsBatchResult, 202: DatasetRowsBatchQueued },
  },
  'POST /datasets/:id/rows/delete': {
    params: IdParam,
    body: DatasetRowsDelete,
    response: { 200: z.object({ deleted: z.number().int() }) },
  },
  'GET /datasets/:id/rows/:rowId': { params: RowParams, response: { 200: DatasetRow } },
  'PATCH /datasets/:id/rows/:rowId': {
    params: RowParams,
    body: DatasetRowPatch,
    response: { 200: DatasetRow },
  },
  'GET /datasets/:id/rows/:rowId/history': {
    params: RowParams,
    response: { 200: z.object({ items: z.array(DatasetRowHistoryEntry) }) },
  },
  'GET /datasets/:id/versions': {
    params: IdParam,
    response: { 200: z.object({ items: z.array(DatasetVersion) }) },
  },
  'GET /datasets/:id/imports': {
    params: IdParam,
    response: { 200: z.object({ items: z.array(ImportRecord) }) },
  },
  'POST /datasets/imports/analyze': { body: ImportAnalyzeInput, response: { 200: ImportAnalysis } },
  'POST /datasets/imports': { body: ImportRunInput, response: { 200: ImportRecord } },
  'GET /datasets/imports/:id': { params: IdParam, response: { 200: ImportRecord } },
  'POST /datasets/imports/:id/publish': { params: IdParam, response: { 200: ImportRecord } },
  'POST /datasets/imports/:id/cancel': { params: IdParam, response: { 200: ImportRecord } },
  'POST /charts': { body: ChartCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /charts/:id': { params: IdParam, response: { 200: ChartRecord } },
  'PATCH /charts/:id': { params: IdParam, body: ChartUpdateInput, response: { 200: ChartRecord } },
  'POST /charts/:id/data': {
    params: IdParam,
    body: ChartDataInput,
    response: { 200: QueryResult },
  },
  'POST /dashboards': { body: DashboardCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /dashboards/:id': { params: IdParam, response: { 200: DashboardRecord } },
  'PATCH /dashboards/:id': {
    params: IdParam,
    body: DashboardUpdateInput,
    response: { 200: DashboardRecord },
  },
  'POST /dashboards/:id/data': {
    params: IdParam,
    body: DashboardDataInput,
    response: { 200: DashboardData },
  },
  'POST /dashboards/:id/drill': {
    params: IdParam,
    body: DashboardDrillInput,
    response: { 200: DashboardDrillResult },
  },
  'GET /system-datasets/:name': {
    params: z.object({ name: z.enum(SYSTEM_DATASETS) }),
    response: { 200: SystemDatasetSchema },
  },
  'POST /metrics': { body: MetricCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /metrics/:id': { params: IdParam, response: { 200: MetricRecord } },
  'PATCH /metrics/:id': {
    params: IdParam,
    body: MetricUpdateInput,
    response: { 200: MetricRecord },
  },
  'POST /metrics/:id/value': {
    params: IdParam,
    body: MetricValueInput,
    response: { 200: MetricValue },
  },
  'POST /internal/data/imports/:id/normalized': {
    params: IdParam,
    body: ENGINE_CALLBACKS.importNormalized.body,
    response: { 200: ENGINE_CALLBACKS.importNormalized.reply },
  },
  'POST /notebooks': { body: NotebookCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /notebooks/:id': { params: IdParam, response: { 200: NotebookRecord } },
  'POST /notebooks/:id/cells': {
    params: IdParam,
    body: NotebookCellsInput,
    response: { 200: NotebookRecord },
  },
  'GET /pipelines': { query: ListQuery, response: { 200: PipelineList } },
  'POST /pipelines': { body: PipelineCreateInput, response: { 200: PipelineRecord } },
  'POST /pipelines/validate': {
    body: PipelineValidateInput,
    response: { 200: PipelineValidateResult },
  },
  'POST /pipelines/preview': { body: PipelinePreviewInput, response: { 200: QueryResult } },
  'GET /pipelines/:id': { params: IdParam, response: { 200: PipelineRecord } },
  'PATCH /pipelines/:id': {
    params: IdParam,
    body: PipelineUpdateInput,
    response: { 200: PipelineRecord },
  },
  'POST /pipelines/:id/run': { params: IdParam, response: { 200: PipelineRunStarted } },
  'GET /pipelines/:id/runs': {
    params: IdParam,
    query: RunsQuery,
    response: { 200: PipelineRunList },
  },
  'GET /sources': { query: ListQuery, response: { 200: SourceList } },
  'POST /sources': { body: SourceCreateInput, response: { 200: SourceRecord } },
  'POST /sources/feeds': { body: FeedSourceCreateInput, response: { 200: SourceRecord } },
  'POST /sources/feed/preview': { body: FeedPreviewInput, response: { 200: FeedPreview } },
  'GET /sources/integrations/:integrationId/tables': {
    params: IntegrationParam,
    response: { 200: SourceTableList },
  },
  'POST /sources/preview': { body: SourcePreviewInput, response: { 200: SourcePreview } },
  'GET /sources/:id': { params: IdParam, response: { 200: SourceRecord } },
  'PATCH /sources/:id': {
    params: IdParam,
    body: SourceUpdateInput,
    response: { 200: SourceRecord },
  },
  'POST /sources/:id/check': { params: IdParam, response: { 200: IntegrationCheckResult } },
  'POST /sources/:id/sync': { params: IdParam, response: { 200: SourceRunStarted } },
  'GET /sources/:id/runs': { params: IdParam, query: RunsQuery, response: { 200: SourceRunList } },
})
