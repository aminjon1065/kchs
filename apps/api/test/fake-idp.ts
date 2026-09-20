import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign as signWith,
} from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Поддельный поставщик OpenID Connect для интеграционных тестов: настоящая
 * конфигурация издателя, настоящий JWKS и настоящая подпись RS256 — но всё в
 * процессе теста, без внешних служб. Экран согласия не нужен: тест сам
 * регистрирует код авторизации, как будто человек уже подтвердил вход.
 */

const b64url = (value: Buffer | string): string =>
  Buffer.isBuffer(value)
    ? value.toString('base64url')
    : Buffer.from(value, 'utf8').toString('base64url')

interface PendingCode {
  nonce: string
  codeChallenge: string
  redirectUri: string
  claims: Record<string, unknown>
  expiresAt: number
}

export interface FakeIdp {
  issuer: string
  clientId: string
  clientSecret: string
  close: () => Promise<void>
  /** Регистрирует код авторизации, который IdP обменяет на токены. */
  authorize: (input: {
    nonce: string
    codeChallenge: string
    redirectUri: string
    claims: Record<string, unknown>
    /** Просроченный код: обмен должен закончиться отказом. */
    expired?: boolean
  }) => string
  tokenRequests: number
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const clientId = 'kchs-test'
  const clientSecret = 'secret-of-the-test-client'
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'test-key'
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
  const codes = new Map<string, PendingCode>()
  const state = { tokenRequests: 0 }

  let issuer = ''

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer)
    const json = (status: number, body: unknown): void => {
      const text = JSON.stringify(body)
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      })
      response.end(text)
    }

    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['openid', 'profile', 'email'],
      })
      return
    }

    if (url.pathname === '/jwks') {
      json(200, { keys: [jwk] })
      return
    }

    if (url.pathname === '/token' && request.method === 'POST') {
      state.tokenRequests += 1
      let body = ''
      request.on('data', (chunk) => {
        body += String(chunk)
      })
      request.on('end', () => {
        const form = new URLSearchParams(body)
        const code = form.get('code') ?? ''
        const pending = codes.get(code)
        codes.delete(code)
        if (!pending || pending.expiresAt < Date.now()) {
          json(400, { error: 'invalid_grant', error_description: 'code expired' })
          return
        }
        if (form.get('client_id') !== clientId) {
          json(401, { error: 'invalid_client' })
          return
        }
        const verifier = form.get('code_verifier') ?? ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (challenge !== pending.codeChallenge) {
          json(400, { error: 'invalid_grant', error_description: 'pkce mismatch' })
          return
        }
        if (form.get('redirect_uri') !== pending.redirectUri) {
          json(400, { error: 'invalid_grant', error_description: 'redirect mismatch' })
          return
        }

        const now = Math.floor(Date.now() / 1000)
        const idToken = signJwt(privateKey, kid, {
          iss: issuer,
          aud: clientId,
          iat: now,
          exp: now + 300,
          nonce: pending.nonce,
          ...pending.claims,
        })
        json(200, {
          access_token: `at-${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
          scope: 'openid profile email',
        })
      })
      return
    }

    json(404, { error: 'not_found' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    issuer,
    clientId,
    clientSecret,
    get tokenRequests() {
      return state.tokenRequests
    },
    authorize: (input) => {
      const code = `code-${randomUUID()}`
      codes.set(code, {
        nonce: input.nonce,
        codeChallenge: input.codeChallenge,
        redirectUri: input.redirectUri,
        claims: input.claims,
        expiresAt: input.expired ? Date.now() - 1000 : Date.now() + 300_000,
      })
      return code
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function signJwt(key: KeyObject, kid: string, payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const body = b64url(JSON.stringify(payload))
  const signature = signWith('sha256', Buffer.from(`${header}.${body}`), key)
  return `${header}.${body}.${signature.toString('base64url')}`
}
