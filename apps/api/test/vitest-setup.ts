/** Общая подготовка тестов: конфигурация из .env монорепо. */
import '../src/shared/config/load-env.js'

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error'
