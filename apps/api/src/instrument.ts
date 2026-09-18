/**
 * Предзагрузка трасс OpenTelemetry — выполняется до импорта приложения:
 *   node --import ./dist/instrument.js dist/main.js
 *   tsx --import ./src/instrument.ts src/main.ts
 * Без адреса OTLP ничего не загружает и не перехватывает (ADR-0045).
 */
import './shared/config/load-env.js'
import { startTracing } from './shared/telemetry/tracing.js'

await startTracing()
