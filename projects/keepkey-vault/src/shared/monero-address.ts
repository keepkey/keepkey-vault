/** Monero mainnet address checks and exact XMR amounts. Shared by the panel and the bun bridge. */
import { keccak_256 } from '@noble/hashes/sha3'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11]
const ATOMIC_UNITS = 1_000_000_000_000n
const MAX_UINT64 = 18446744073709551615n

export type MoneroAddressKind = 'standard' | 'subaddress' | 'integrated'

/** Monero base58: 8-byte blocks as 11 characters, a shorter final block. */
function decode(text: string): Uint8Array | null {
  const bytes: number[] = []
  for (let offset = 0; offset < text.length; offset += 11) {
    const block = text.slice(offset, offset + 11), size = BLOCK_CHARS.indexOf(block.length)
    if (size < 1) return null
    let value = 0n
    for (const char of block) {
      const digit = ALPHABET.indexOf(char)
      if (digit < 0) return null
      value = value * 58n + BigInt(digit)
    }
    if (value >> BigInt(size * 8)) return null
    for (let i = size - 1; i >= 0; i--) bytes.push(Number((value >> BigInt(i * 8)) & 255n))
  }
  return new Uint8Array(bytes)
}

/** Mainnet network byte and Keccak checksum; null for anything else. */
export function moneroAddressKind(address: unknown): MoneroAddressKind | null {
  if (typeof address !== 'string' || (address.length !== 95 && address.length !== 106)) return null
  const data = decode(address)
  if (!data) return null
  const kind = data[0] === 18 ? 'standard' : data[0] === 42 ? 'subaddress' : data[0] === 19 ? 'integrated' : null
  if (!kind || data.length !== (kind === 'integrated' ? 77 : 69)) return null
  const checksum = keccak_256(data.subarray(0, data.length - 4))
  return checksum.subarray(0, 4).every((byte, i) => byte === data[data.length - 4 + i]) ? kind : null
}

/** Public keys from a checked mainnet standard address, for the bounded device signer. */
export function moneroStandardAddressKeys(address: string): { spend: Uint8Array; view: Uint8Array } | null {
  if (moneroAddressKind(address) !== 'standard') return null
  const data = decode(address)!
  return { spend: data.slice(1,33), view: data.slice(33,65) }
}

/** Checked mainnet standard/subaddress public keys for construction v2. */
export function moneroDestinationAddressKeys(address: string): { kind: 'standard' | 'subaddress'; spend: Uint8Array; view: Uint8Array } | null {
  const kind=moneroAddressKind(address)
  if(kind!=='standard'&&kind!=='subaddress')return null
  const data=decode(address)!
  return {kind,spend:data.slice(1,33),view:data.slice(33,65)}
}

/** "1.5" -> "1500000000000". Null for zero, more than 12 decimals or above uint64. */
export function parseXmrAmount(text: string): string | null {
  const match = /^([0-9]{1,8})(?:\.([0-9]{1,12}))?$/.exec(text.trim())
  if (!match) return null
  const value = BigInt(match[1]) * ATOMIC_UNITS + BigInt((match[2] ?? '').padEnd(12, '0'))
  return value > 0n && value <= MAX_UINT64 ? value.toString() : null
}

/** The device's own format: all twelve decimals, never through Number. */
export function formatXmrAtomic(value: string | bigint): string {
  const amount = BigInt(value)
  return `${amount / ATOMIC_UNITS}.${(amount % ATOMIC_UNITS).toString().padStart(12, '0')} XMR`
}
