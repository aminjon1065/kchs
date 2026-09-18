import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Слияние классов с разрешением конфликтов Tailwind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
