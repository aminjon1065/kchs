export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? string : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type TranslateParams = Record<string, string | number | Date | undefined>
