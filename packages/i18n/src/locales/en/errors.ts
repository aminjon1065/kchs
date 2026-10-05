import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const errors: DeepPartial<Dictionary['errors']> = {
  validation_failed: 'Check the form fields',
  not_found: 'Not found',
  forbidden: 'Not enough permissions',
  unauthorized: 'Sign-in required',
  conflict: 'Conflicting changes',
  precondition_failed: 'Changed by someone else — reload the page',
  rate_limited: 'Too many requests, try again later',
  dependency_failed: 'Failed because of a related operation',
  query_timeout: 'The query took too long',
  policy_violation: 'Blocked by policy',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported file type',
  internal_error: 'Internal error. We are already aware',
  service_unavailable: 'Service temporarily unavailable',
  mfa_required: 'Second factor required',
  password_change_required: 'Password change required',
  network: 'No connection to the server',
  unknown: 'Unexpected error',
  requestFailed: 'Request failed',
}
