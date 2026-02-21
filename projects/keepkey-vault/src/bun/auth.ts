export interface PairingInfo {
  name: string
  url: string
  imageUrl: string
  addedOn?: number
}

interface PairedClient {
  apiKey: string
  info: PairingInfo
}

export class AuthStore {
  private keys = new Map<string, PairedClient>()
  private accounts = new Map<string, number[]>()

  pair(info: PairingInfo): string {
    const apiKey = crypto.randomUUID()
    this.keys.set(apiKey, { apiKey, info: { ...info, addedOn: Date.now() } })
    return apiKey
  }

  validate(apiKey: string): PairedClient | null {
    return this.keys.get(apiKey) ?? null
  }

  extractBearerToken(req: Request): string | null {
    const header = req.headers.get('Authorization')
    if (!header) return null
    const match = header.match(/^Bearer\s+(.+)$/i)
    return match ? match[1] : null
  }

  requireAuth(req: Request): PairedClient {
    const token = this.extractBearerToken(req)
    if (!token) throw { status: 403, message: 'Missing Authorization header' }
    const entry = this.validate(token)
    if (!entry) throw { status: 403, message: 'Invalid API key' }
    return entry
  }

  saveAccount(address: string, addressNList: number[]): void {
    this.accounts.set(address.toLowerCase(), addressNList)
  }

  getAccount(address: string): { addressNList: number[] } {
    const addressNList = this.accounts.get(address.toLowerCase())
    if (!addressNList) throw { status: 400, message: `Unrecognized address: ${address}` }
    return { addressNList }
  }
}
