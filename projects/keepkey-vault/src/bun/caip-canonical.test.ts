import { describe, it, expect } from 'bun:test'
import { CHAINS } from '../shared/chains'

/* Mirror of canonicalizeCaipNetwork in index.ts (which is not exported —
 * the logic is small and the property worth pinning is the one below). */
const canon = new Map(CHAINS.map(c => [c.networkId.toLowerCase(), c.networkId]))
function canonicalizeCaipNetwork(caip: string): string {
  const slash = caip.indexOf('/')
  if (slash < 0) return caip
  const prefix = caip.slice(0, slash)
  const c = canon.get(prefix.toLowerCase())
  return c && c !== prefix ? c + caip.slice(slash) : caip
}

describe('CAIP network canonicalization', () => {
  /* Solana network ids are base58 and case-SENSITIVE. Pioneer lowercases them
   * on token CAIPs; the icon URL is base64(caip), so the damaged key 403s. */
  it('restores Solana network casing (the USDT icon bug)', () => {
    const damaged = 'solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    const fixed = canonicalizeCaipNetwork(damaged)
    expect(fixed).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
    // The base64 key is what the CDN is asked for.
    expect(Buffer.from(fixed).toString('base64').replace(/=+$/, ''))
      .toBe('c29sYW5hOjVleWt0NFVzRnY4UDhOSmRUUkVwWTF2enFLcVpLdmRwL3Rva2VuOkVzOXZNRnJ6YUNFUm1KZnJGNEgyRllENEtDb05rWTExTWNDZThCZW53TllC')
  })

  it('never alters the asset part — mints and contracts are case-sensitive too', () => {
    const mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    expect(canonicalizeCaipNetwork(`solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp/token:${mint}`)).toContain(mint)
  })

  it('leaves already-correct and unknown networks untouched', () => {
    const ok = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501'
    expect(canonicalizeCaipNetwork(ok)).toBe(ok)
    const unknown = 'weird:NotAChain/token:abc'
    expect(canonicalizeCaipNetwork(unknown)).toBe(unknown)
    expect(canonicalizeCaipNetwork('eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7'))
      .toBe('eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7')
  })
})
