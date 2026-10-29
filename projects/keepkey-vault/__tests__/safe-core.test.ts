import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/safe/safedao-nonce76.json'
import { safeTxHash, verifiedSigners, safeTxDomain, SAFE_READS, decodeSafeRead } from '../src/bun/safe-core'

// A real executed transaction from the Safe DAO treasury (Safe 1.3.0, chain 1):
// a delegatecall to MultiSendCallOnly with 676 bytes of data and three
// confirmations. Safe's service published its safeTxHash and signatures.
const tx = fixture as any

describe('SafeTx hash is computed locally, not trusted', () => {
  test('matches the safeTxHash Safe published for this transaction', () => {
    expect(safeTxHash(tx.chainId, tx.safe, tx.version, tx)).toBe(tx.safeTxHash)
  })

  test('any changed field changes the hash', () => {
    expect(safeTxHash(tx.chainId, tx.safe, tx.version, { ...tx, operation: 0 })).not.toBe(tx.safeTxHash)
    expect(safeTxHash(tx.chainId, tx.safe, tx.version, { ...tx, value: '1' })).not.toBe(tx.safeTxHash)
    expect(safeTxHash(10, tx.safe, tx.version, tx)).not.toBe(tx.safeTxHash) // another chain
  })

  test('Safe 1.1.1 signs without chainId in the domain', () => {
    expect(safeTxDomain(1, tx.safe, '1.1.1')).toEqual({ verifyingContract: tx.safe })
    expect(safeTxDomain(1, tx.safe, '1.4.1')).toEqual({ chainId: 1, verifyingContract: tx.safe })
  })
})

describe('confirmations count only when the signature recovers to an owner', () => {
  test("two ECDSA signatures verify; the executor's approved-hash entry is reported, not counted", () => {
    // Signatures are v 28, v 1, v 28: the middle owner executed the transaction,
    // which Safe records as an approved hash that cannot be checked offline.
    const { verified, unverifiable } = verifiedSigners(tx.safeTxHash, tx.signatures, tx.owners)
    expect(verified.sort()).toEqual(['0x3242071b0b406B6661AF2dE1115CD46567Ab0917', '0xb1Df01604095536CEA66a9D06E67Ed6F00684e58'])
    expect(unverifiable).toEqual(['0x6b28FdCF3059dd13847648213175dCa8853557B5'])
    expect([...verified, ...unverifiable].map((a: string) => a.toLowerCase()).sort())
      .toEqual(tx.confirmationOwners.map((a: string) => a.toLowerCase()).sort())
  })

  test('signatures over a different hash verify nobody', () => {
    const other = safeTxHash(tx.chainId, tx.safe, tx.version, { ...tx, value: '1' })
    expect(verifiedSigners(other, tx.signatures, tx.owners).verified).toEqual([])
  })

  test('a signer who is not an owner is not counted', () => {
    expect(verifiedSigners(tx.safeTxHash, tx.signatures, [tx.owners[0]].filter((o: string) => !tx.confirmationOwners.includes(o))).verified).toEqual([])
  })
})

test('read calls encode the standard Safe selectors', () => {
  expect(SAFE_READS.getOwners).toBe('0xa0e67e2b')
  expect(SAFE_READS.getThreshold).toBe('0xe75235b8')
  expect(SAFE_READS.nonce).toBe('0xaffed0e0')
  expect(SAFE_READS.VERSION).toBe('0xffa1ad74')
  expect(decodeSafeRead('getThreshold', '0x' + '3'.padStart(64, '0')).toString()).toBe('3')
})
