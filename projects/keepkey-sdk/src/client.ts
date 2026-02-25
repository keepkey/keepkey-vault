import type { PairResponse } from './types'

export class VaultClient {
  private baseUrl: string
  private apiKey: string | null
  private serviceName: string
  private serviceImageUrl: string

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

  /** GET request */
  async get<T = any>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (resp.status === 403 && this.apiKey) {
      // Token may have expired — try re-pairing once
      const rePaired = await this.tryRePair()
      if (rePaired) {
        const retry = await fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: this.headers(),
        })
        if (!retry.ok) throw new SdkError(retry.status, await retry.text())
        return retry.json() as Promise<T>
      }
    }
    if (!resp.ok) throw new SdkError(resp.status, await resp.text())
    return resp.json() as Promise<T>
  }

  /** POST request */
  async post<T = any>(path: string, body?: any): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (resp.status === 403 && this.apiKey) {
      const rePaired = await this.tryRePair()
      if (rePaired) {
        const retry = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: this.headers(),
          body: body !== undefined ? JSON.stringify(body) : undefined,
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
    })
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
    })
    if (!resp.ok) throw new SdkError(resp.status, `Pairing failed: ${await resp.text()}`)
    const data = (await resp.json()) as PairResponse
    this.apiKey = data.apiKey
    return data.apiKey
  }

  /** Check if vault is reachable */
  async ping(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/health`, { method: 'GET' })
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
      })
      if (!resp.ok) return false
      const data = (await resp.json()) as { paired: boolean }
      return data.paired === true
    } catch {
      return false
    }
  }

  /** Attempt to re-pair when a 403 is received */
  private async tryRePair(): Promise<boolean> {
    try {
      await this.pair()
      return true
    } catch {
      return false
    }
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
