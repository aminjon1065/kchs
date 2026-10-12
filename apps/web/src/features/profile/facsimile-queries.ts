import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Своё факсимиле (ADR-0198): картинку отдают только владельцу. */
export const facsimileKey = ['me', 'facsimile'] as const

export const facsimileQuery = () =>
  queryOptions({ queryKey: facsimileKey, queryFn: () => http.get('/me/facsimile') })

export const saveFacsimile = (png: string) => http.put('/me/facsimile', { body: { png } })

export const removeFacsimile = () => http.delete('/me/facsimile')
