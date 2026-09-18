import { ROOT_CONTEXT } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import {
  contextFromMetadata,
  serviceAttributes,
  traceLogFields,
  traceMetadata,
  tracingEnabled,
  tracingRequested,
  withSpan,
} from './tracing.js'

const TRACEPARENT = JSON.stringify({
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
})

describe('трассы без адреса OTLP (ADR-0045)', () => {
  it('выключены: помощники не создают спанов и не меняют поведение', async () => {
    expect(tracingEnabled()).toBe(false)
    const result = await withSpan('проверка', {}, async (span) => {
      expect(span).toBeUndefined()
      return 42
    })
    expect(result).toBe(42)
    await expect(
      withSpan('ошибка', {}, async () => {
        throw new Error('сбой')
      }),
    ).rejects.toThrow('сбой')
    expect(traceMetadata()).toBeUndefined()
    expect(contextFromMetadata(TRACEPARENT)).toBe(ROOT_CONTEXT)
    expect(traceLogFields()).toEqual({})
  })

  it('включаются адресом OTLP, OTEL_SDK_DISABLED выключает', () => {
    expect(tracingRequested({})).toBe(false)
    expect(tracingRequested({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4318' })).toBe(true)
    expect(
      tracingRequested({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://tempo:4318/v1/traces' }),
    ).toBe(true)
    expect(
      tracingRequested({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4318',
        OTEL_SDK_DISABLED: 'true',
      }),
    ).toBe(false)
  })

  it('имя сервиса — по роли процесса, OTEL_SERVICE_NAME переопределяет', () => {
    expect(serviceAttributes({ ROLE: 'worker' })['service.name']).toBe('kchs-worker')
    expect(serviceAttributes({})['service.name']).toBe('kchs-all')
    expect(
      serviceAttributes({ ROLE: 'api', OTEL_SERVICE_NAME: 'kchs-api-2' })['service.name'],
    ).toBe('kchs-api-2')
  })
})
