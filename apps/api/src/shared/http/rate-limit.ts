import { config } from '../config/index.js'

/**
 * Ограничения частоты запросов (17-security.md §5).
 * В тестовой среде лимиты сняты: интеграционные тесты выполняют десятки
 * входов подряд, а само ограничение проверяется отдельным сценарием.
 */
export function rateLimit(max: number, timeWindow: string): { max: number; timeWindow: string } {
  return config().NODE_ENV === 'test' ? { max: 100_000, timeWindow } : { max, timeWindow }
}
