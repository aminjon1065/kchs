import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import {
  MeetingCreateInput,
  MeetingGuestJoin,
  MeetingGuestJoinInput,
  MeetingGuestLink,
  MeetingGuestLinkInput,
  MeetingGuestPreview,
  MeetingJoin,
  MeetingKnockDecision,
  MeetingKnockList,
  MeetingList,
  MeetingListQuery,
  MeetingRecord,
  MeetingSecretaryInput,
  MeetingsStatus,
} from '../../meetings/meeting.js'
import {
  ProtocolAcknowledgeInput,
  ProtocolBlocksInput,
  ProtocolDraft,
  ProtocolRecord,
  ProtocolRegisterInput,
  ProtocolResponse,
} from '../../meetings/protocol.js'
import {
  MeetingSettings,
  RecordingList,
  RecordingPinInput,
  RecordingRecord,
  TranscriptRecord,
  TranscriptResult,
  TranscriptSegmentEditInput,
  TranscriptSpeakerInput,
} from '../../meetings/recording.js'
import { IdParam } from '../params.js'

/** Токен ссылки: `<встреча>.<срок>.<подпись>` — только безопасные символы. */
const TokenParam = z.object({ token: z.string().min(40).max(200) })

const KnockParams = z.object({ id: z.uuid(), requestId: z.uuid() })

/**
 * Маршруты модуля «meetings» (ADR-0188). Регистрация — `apps/api/src/modules/meetings/`:
 * http/guest-routes.ts, http/protocol-routes.ts, http/recording-routes.ts,
 * http/room-routes.ts, http.ts.
 */
export const meetingsRoutes = defineRoutes({
  'POST /meetings/:id/guest-link': {
    params: IdParam,
    body: MeetingGuestLinkInput,
    response: { 200: MeetingGuestLink },
  },
  'GET /meetings/guest/:token': { params: TokenParam, response: { 200: MeetingGuestPreview } },
  'POST /meetings/guest/:token/join': {
    params: TokenParam,
    body: MeetingGuestJoinInput,
    response: { 200: MeetingGuestJoin },
  },
  'GET /meetings/:id/protocol': { params: IdParam, response: { 200: ProtocolResponse } },
  'POST /meetings/:id/protocol': { params: IdParam, response: { 200: ProtocolRecord } },
  'GET /protocols/:id': { params: IdParam, response: { 200: ProtocolRecord } },
  'POST /protocols/:id/blocks': {
    params: IdParam,
    body: ProtocolBlocksInput,
    response: { 200: ProtocolRecord },
  },
  'POST /protocols/:id/draft': { params: IdParam, response: { 200: ProtocolDraft } },
  'POST /protocols/:id/confirm': { params: IdParam, response: { 200: ProtocolRecord } },
  'POST /protocols/:id/register': {
    params: IdParam,
    body: ProtocolRegisterInput,
    response: { 200: z.object({ documentId: z.uuid() }) },
  },
  'POST /protocols/:id/print': { params: IdParam, response: { 200: ProtocolRecord } },
  'POST /protocols/:id/acknowledgments': {
    params: IdParam,
    body: ProtocolAcknowledgeInput,
    response: { 200: z.object({ requested: z.number().int() }) },
  },
  'POST /meetings/:id/recording/start': { params: IdParam, response: { 200: RecordingRecord } },
  'POST /recordings/:id/stop': { params: IdParam, response: { 200: RecordingRecord } },
  'GET /meetings/:id/recordings': { params: IdParam, response: { 200: RecordingList } },
  'GET /recordings/:id': { params: IdParam, response: { 200: RecordingRecord } },
  'POST /recordings/:id/pin': {
    params: IdParam,
    body: RecordingPinInput,
    response: { 200: RecordingRecord },
  },
  'GET /admin/meetings/settings': { response: { 200: MeetingSettings } },
  'PUT /admin/meetings/settings': { body: MeetingSettings, response: { 200: MeetingSettings } },
  'GET /recordings/:id/transcript': { params: IdParam, response: { 200: TranscriptRecord } },
  'PATCH /recordings/:id/transcript/segments/:index': {
    params: z.object({ id: z.uuid(), index: z.coerce.number().int().min(0) }),
    body: TranscriptSegmentEditInput,
    response: { 200: TranscriptRecord },
  },
  'PUT /recordings/:id/transcript/speakers': {
    params: IdParam,
    body: TranscriptSpeakerInput,
    response: { 200: TranscriptRecord },
  },
  'POST /meetings/webhooks/livekit': {
    response: { 200: z.object({ ok: z.literal(true), handled: z.boolean() }) },
  },
  'POST /internal/meetings/recordings/:id/transcript': {
    params: IdParam,
    body: TranscriptResult,
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
  'GET /meetings/:id/knocks': { params: IdParam, response: { 200: MeetingKnockList } },
  'POST /meetings/:id/knocks/:requestId': {
    params: KnockParams,
    body: MeetingKnockDecision,
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
  'POST /meetings/:id/decline': {
    params: IdParam,
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
  'GET /meetings/status': { response: { 200: MeetingsStatus } },
  'GET /meetings': { query: MeetingListQuery, response: { 200: MeetingList } },
  'POST /meetings': { body: MeetingCreateInput, response: { 200: MeetingRecord } },
  'GET /meetings/:id': { params: IdParam, response: { 200: MeetingRecord } },
  'POST /meetings/:id/join': { params: IdParam, response: { 200: MeetingJoin } },
  'POST /meetings/:id/leave': {
    params: IdParam,
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
  'PUT /meetings/:id/secretary': {
    params: IdParam,
    body: MeetingSecretaryInput,
    response: { 200: MeetingRecord },
  },
  'POST /meetings/:id/end': { params: IdParam, response: { 200: MeetingRecord } },
})
