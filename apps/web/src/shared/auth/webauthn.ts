/**
 * Ключи входа в браузере (WebAuthn, ADR-0098).
 *
 * Сервер присылает и принимает структуры стандарта в виде JSON (строки
 * base64url), а `navigator.credentials` работает с `ArrayBuffer` — здесь
 * только перевод между ними. Ничего, кроме ответа устройства, наружу не идёт.
 */

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Браузер умеет ключи входа и страница отдана по защищённому соединению. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(window.PublicKeyCredential)
}

interface DescriptorJson {
  id: string
  type?: string
  transports?: string[]
}

function descriptors(list: DescriptorJson[] | undefined): PublicKeyCredentialDescriptor[] {
  return (list ?? []).map((item) => ({
    id: fromBase64Url(item.id) as unknown as BufferSource,
    type: 'public-key',
    ...(item.transports ? { transports: item.transports as AuthenticatorTransport[] } : {}),
  }))
}

/** Ответ устройства в форме, которую принимает сервер. */
export interface CredentialPayload {
  id: string
  rawId: string
  type: string
  clientExtensionResults: Record<string, unknown>
  response: Record<string, unknown>
}

type CreationOptionsJson = {
  challenge: string
  rp: PublicKeyCredentialRpEntity
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  timeout?: number
  excludeCredentials?: DescriptorJson[]
  authenticatorSelection?: AuthenticatorSelectionCriteria
  attestation?: AttestationConveyancePreference
}

export async function createPasskey(
  options: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CredentialPayload> {
  const json = options as unknown as CreationOptionsJson
  const credential = (await navigator.credentials.create({
    ...(signal ? { signal } : {}),
    publicKey: {
      challenge: fromBase64Url(json.challenge) as unknown as BufferSource,
      rp: json.rp,
      user: {
        id: fromBase64Url(json.user.id) as unknown as BufferSource,
        name: json.user.name,
        displayName: json.user.displayName,
      },
      pubKeyCredParams: json.pubKeyCredParams,
      ...(json.timeout ? { timeout: json.timeout } : {}),
      excludeCredentials: descriptors(json.excludeCredentials),
      ...(json.authenticatorSelection
        ? { authenticatorSelection: json.authenticatorSelection }
        : {}),
      ...(json.attestation ? { attestation: json.attestation } : {}),
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('passkey.cancelled')

  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  }
}

type RequestOptionsJson = {
  challenge: string
  rpId?: string
  timeout?: number
  allowCredentials?: DescriptorJson[]
  userVerification?: UserVerificationRequirement
}

export async function requestPasskey(
  options: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CredentialPayload> {
  const json = options as unknown as RequestOptionsJson
  const credential = (await navigator.credentials.get({
    ...(signal ? { signal } : {}),
    publicKey: {
      challenge: fromBase64Url(json.challenge) as unknown as BufferSource,
      ...(json.rpId ? { rpId: json.rpId } : {}),
      ...(json.timeout ? { timeout: json.timeout } : {}),
      allowCredentials: descriptors(json.allowCredentials),
      ...(json.userVerification ? { userVerification: json.userVerification } : {}),
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('passkey.cancelled')

  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      ...(response.userHandle ? { userHandle: toBase64Url(response.userHandle) } : {}),
    },
  }
}
