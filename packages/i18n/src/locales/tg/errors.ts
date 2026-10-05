import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const errors: DeepPartial<Dictionary['errors']> = {
  validation_failed: 'Пуркунии майдонҳоро санҷед',
  not_found: 'Объект ёфт нашуд',
  forbidden: 'Ҳуқуқ нокифоя аст',
  unauthorized: 'Воридшавӣ лозим аст',
  conflict: 'Бархӯрди тағйирот',
  precondition_failed: 'Объектро корбари дигар тағйир додааст — саҳифаро нав кунед',
  rate_limited: 'Дархостҳо аз ҳад зиёданд, баъдтар кӯшиш кунед',
  dependency_failed: 'Бо сабаби амалиёти алоқаманд иҷро нашуд',
  query_timeout: 'Иҷрои дархост аз ҳад зиёд вақт гирифт',
  policy_violation: 'Амал бо сиёсат манъ аст',
  payload_too_large: 'Ҳаҷми маълумот аз ҳад зиёд аст',
  unsupported_media_type: 'Навъи файл дастгирӣ намешавад',
  internal_error: 'Хатои дохилӣ. Мо аллакай аз он огоҳем',
  service_unavailable: 'Хадамот муваққатан дастнорас аст',
  mfa_required: 'Тасдиқ бо омили дуюм лозим аст',
  password_change_required: 'Рамзро иваз кардан лозим аст',
  network: 'Бо сервер алоқа нест',
  unknown: 'Хатои пешбининашуда',
  requestFailed: 'Хатои дархост',
}
