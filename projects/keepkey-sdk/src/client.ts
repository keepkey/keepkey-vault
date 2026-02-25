import type { PairResponse } from './types'

const DEFAULT_TIMEOUT_MS = 30_000
const SIGNING_TIMEOUT_MS = 600_000

export class VaultClient {
  private baseUrl: string
  private apiKey: string | null
  private serviceName: string
  private serviceImageUrl: string
  private rePairPromise: Promise<boolean> | null = null
  /** Default timeout for read operations (ms). */
  timeoutMs: number
  /** Timeout for signing operations (ms). */
  signingTimeoutMs: number

  constructor(
    baseUrl: string,
    apiKey?: string,
    serviceName = 'keepkey-vault-sdk',
    serviceImageUrl = '',
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey || null
    this.serviceName = serviceName
    this.serviceImageUrl = serviceImageUrl
    this.timeoutMs = DEFAULT_TIMEOUT_MS
    this.signingTimeoutMs = SIGNING_TIMEOUT_MS
  }

  /** Current API key (set after pairing) */
  getApiKey(): string | null {
    return this.apiKey
  }

  /** Set API key (e.g. after manual pairing) */
  setApiKey(key: string): void {
    this.apiKey = key
  }

  /** Build headers for a request */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  /** Create an AbortSignal with timeout */
  private signal(ms?: number): AbortSignal {
    return AbortSignal.timeout(ms ?? this.timeoutMs)
  }

  /** GET request */
  async get<T = any>(path: string, timeoutMs?: number): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
      signal: this.signal(timeoutMs),
    })
    if (resp.status === 403 && this.apiKey) {
      const rePaired = await this.tryRePair()
      if (rePaired) {
        const retry = await fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: this.headers(),
          signal: this.signal(timeoutMs),
        })
        if (!retry.ok) throw new SdkError(retry.status, await retry.text())
        return retry.json() as Promise<T>
      }
    }
    if (!resp.ok) throw new SdkError(resp.status, await resp.text())
    return resp.json() as Promise<T>
  }

  /** POST request */
  async post<T = any>(path: string, body?: any, timeoutMs?: number): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: this.signal(timeoutMs),
    })
    if (resp.status === 403 && this.apiKey) {
      const rePaired = await this.tryRePair()
      if (rePaired) {
        const retry = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: this.headers(),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: this.signal(timeoutMs),
        })
        if (!retry.ok) throw new SdkError(retry.status, await retry.text())
        return retry.json() as Promise<T>
      }
    }
    if (!resp.ok) throw new SdkError(resp.status, await resp.text())
    return resp.json() as Promise<T>
  }

  /** DELETE request */
  async delete<T = any>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: this.signal(),
    })
    if (resp.status === 403 && this.apiKey) {
      const rePaired = await this.tryRePair()
      if (rePaired) {
        const retry = await fetch(`${this.baseUrl}${path}`, {
          method: 'DELETE',
          headers: this.headers(),
          signal: this.signal(),
        })
        if (!retry.ok) throw new SdkError(retry.status, await retry.text())
        return retry.json() as Promise<T>
      }
    }
    if (!resp.ok) throw new SdkError(resp.status, await resp.text())
    return resp.json() as Promise<T>
  }

  /** Pair with the vault — user must approve on the device UI */
  async pair(): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.serviceName,
        url: '',
        imageUrl: this.serviceImageUrl,
      }),
      signal: this.signal(this.signingTimeoutMs),
    })
    if (!resp.ok) throw new SdkError(resp.status, `Pairing failed: ${await resp.text()}`)
    const data = (await resp.json()) as PairResponse
    if (!data || typeof data.apiKey !== 'string' || !data.apiKey) {
      throw new SdkError(500, 'Pairing response missing apiKey')
    }
    this.apiKey = data.apiKey
    return data.apiKey
  }

  /** Check if vault is reachable */
  async ping(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/health`, {
        method: 'GET',
        signal: this.signal(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  /** Verify current API key is valid */
  async verifyAuth(): Promise<boolean> {
    if (!this.apiKey) return false
    try {
      const resp = await fetch(`${this.baseUrl}/auth/pair`, {
        method: 'GET',
        headers: this.headers(),
        signal: this.signal(),
      })
      if (!resp.ok) return false
      const data = (await resp.json()) as { paired: boolean }
      return data.paired === true
    } catch {
      return false
    }
  }

  /**
   * Attempt to re-pair when a 403 is received.
   * Uses a mutex so concurrent 403s only trigger one re-pair attempt.
   */
  private async tryRePair(): Promise<boolean> {
    if (this.rePairPromise) return this.rePairPromise
    this.rePairPromise = this.pair().then(() => true, () => false)
      .finally(() => { this.rePairPromise = null })
    return this.rePairPromise
  }
}

/** SDK-specific error with HTTP status */
export class SdkError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'SdkError'
    this.status = status
  }
}
