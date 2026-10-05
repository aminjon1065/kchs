import { RtJobFinished, RtJobProgress } from '@kchs/contracts'
import { z } from 'zod'
import { redis } from '~/shared/redis/index.js'

/**
 * Сигнал задания для realtime: ход и исход попытки. Запись задания меняет процесс, где оно
 * выполняется (worker, движок через api), а сокеты открыты на узлах api: сигнал через Redis
 * получает каждый узел и доставляет своим сокетам — в комнату задания и в комнату
 * инициатора, чьи вкладки показывают «Мои задания» (ADR-0192).
 */
export const JOB_SIGNAL_CHANNEL = 'rt:job'

const Initiator = { initiatorId: z.string().nullable() }

export const JobSignal = z.union([RtJobProgress.extend(Initiator), RtJobFinished.extend(Initiator)])
export type JobSignal = z.infer<typeof JobSignal>

export async function publishJobSignal(signal: JobSignal): Promise<void> {
  await redis().publish(JOB_SIGNAL_CHANNEL, JSON.stringify(signal))
}
