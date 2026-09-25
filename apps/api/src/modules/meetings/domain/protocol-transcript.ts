/**
 * Расшифровка встречи для черновика протокола (11-communications-meetings.md
 * §4, ADR-0093). Расшифровку ведёт своя часть модуля встреч (запись → движок →
 * сегменты); протокол читает её через этот порт и мягко деградирует: источник
 * не подключён или расшифровки нет — черновик готовится только по повестке.
 */

export interface TranscriptText {
  /** Реплики с говорящими, уже сведённые в текст. */
  text: string
  /** Текст обрезан по лимиту запроса. */
  truncated: boolean
  /**
   * Запись, чья расшифровка использована: протокол связывается с ней — запись,
   * попавшая в протокол, не удаляется по сроку хранения (N29, ADR-0138).
   */
  recordingId?: string
}

export interface TranscriptSource {
  /** Текст расшифровки встречи, не длиннее `limit` символов; null — её нет. */
  textOf: (meetingId: string, limit: number) => Promise<TranscriptText | null>
}

let source: TranscriptSource | null = null

/** Источник расшифровок подключает модуль встреч при старте, если он есть. */
export function setTranscriptSource(next: TranscriptSource | null): void {
  source = next
}

/** Расшифровка встречи или null: и когда источника нет, и когда он не ответил. */
export async function transcriptText(
  meetingId: string,
  limit: number,
): Promise<TranscriptText | null> {
  if (!source) return null
  const result = await source.textOf(meetingId, limit)
  return result?.text.trim() ? result : null
}
