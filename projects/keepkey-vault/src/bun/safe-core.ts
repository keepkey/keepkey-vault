/**
 * Safe multisig primitives, computed locally so nothing a remote service says
 * about a transaction is trusted: the SafeTx EIP-712 document and its hash,
 * and which owners' signatures actually recover over that hash.
 */
import { ethers } from 'ethers'

export interface SafeTxFields {
  to: string
  value: string
  data: string | null
  operation: number
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: string
  refundReceiver: string
  nonce: string
}

export const SAFE_TX_TYPE = [
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' },
  { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' },
  { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' },
  { name: 'nonce', type: 'uint256' },
]

/** Safe 1.3.0 added chainId to the domain; 1.1.1 and older sign without it. */
export function safeTxDomain(chainId: number, safe: string, version: string): ethers.TypedDataDomain {
  const [major, minor] = version.split('.').map(Number)
  const withChainId = major > 1 || (major === 1 && minor >= 3)
  return withChainId ? { chainId, verifyingContract: safe } : { verifyingContract: safe }
}

function message(tx: SafeTxFields) {
  return { ...tx, data: tx.data || '0x' }
}

/** The safeTxHash an owner signs, from the transaction's own fields. */
export function safeTxHash(chainId: number, safe: string, version: string, tx: SafeTxFields): string {
  return ethers.utils._TypedDataEncoder.hash(safeTxDomain(chainId, safe, version), { SafeTx: SAFE_TX_TYPE }, message(tx))
}

/**
 * Owners whose signature in Safe's packed format recovers over safeTxHash.
 * ECDSA (v 27/28) and eth_sign (v 31/32) are checked; contract signatures
 * (v 0) and approved hashes (v 1) cannot be checked offline and are returned
 * separately, never counted as verified.
 */
export function verifiedSigners(hash: string, signatures: string, owners: string[]): { verified: string[]; unverifiable: string[] } {
  const ownerSet = new Map(owners.map(o => [o.toLowerCase(), ethers.utils.getAddress(o)]))
  const bytes = ethers.utils.arrayify(signatures || '0x')
  const verified: string[] = []
  const unverifiable: string[] = []
  for (let i = 0; i + 65 <= bytes.length; i += 65) {
    const r = ethers.utils.hexlify(bytes.slice(i, i + 32)), s = ethers.utils.hexlify(bytes.slice(i + 32, i + 64)), v = bytes[i + 64]
    let signer: string | undefined
    if (v === 27 || v === 28) {
      signer = ethers.utils.recoverAddress(hash, { r, s, v })
    } else if (v === 31 || v === 32) {
      signer = ethers.utils.recoverAddress(ethers.utils.hashMessage(ethers.utils.arrayify(hash)), { r, s, v: v - 4 })
    } else if (v === 0 || v === 1) {
      // r holds the signer address, left-padded.
      unverifiable.push(ethers.utils.getAddress(ethers.utils.hexDataSlice(r, 12)))
      continue
    }
    const owner = signer && ownerSet.get(signer.toLowerCase())
    if (owner && !verified.includes(owner)) verified.push(owner)
  }
  return { verified, unverifiable }
}

const iface = new ethers.utils.Interface([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
])

export const SAFE_READS = {
  getOwners: iface.encodeFunctionData('getOwners'),
  getThreshold: iface.encodeFunctionData('getThreshold'),
  nonce: iface.encodeFunctionData('nonce'),
  VERSION: iface.encodeFunctionData('VERSION'),
} as const

export function decodeSafeRead<K extends keyof typeof SAFE_READS>(fn: K, result: string): any {
  return iface.decodeFunctionResult(fn, result)[0]
}
