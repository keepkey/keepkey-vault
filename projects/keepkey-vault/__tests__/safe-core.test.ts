import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/safe/safedao-nonce76.json'
import { ethers } from 'ethers'
import { safeTxHash, verifiedSigners, checkConfirmation, approvedHashCall, safeTxDomain, safeTypedData, safeSignature, SAFE_READS, decodeSafeRead } from '../src/bun/safe-core'

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

describe('each service confirmation is checked against the owner it names', () => {
  // The packed signatures are sorted by owner: 0x3242… (v 28), 0x6b28… (v 1), 0xb1Df… (v 28).
  const sig = (i: number) => '0x' + tx.signatures.slice(2 + i * 130, 2 + (i + 1) * 130)
  const [A, B, C] = ['0x3242071b0b406B6661AF2dE1115CD46567Ab0917', '0x6b28FdCF3059dd13847648213175dCa8853557B5', '0xb1Df01604095536CEA66a9D06E67Ed6F00684e58']

  test('an ECDSA signature counts only for the owner it recovers to', () => {
    expect(checkConfirmation(tx.safeTxHash, tx.owners, { owner: A, signature: sig(0) })).toBe('verified')
    expect(checkConfirmation(tx.safeTxHash, tx.owners, { owner: C, signature: sig(2) })).toBe('verified')
    // A real signature credited to another owner is not counted for them.
    expect(checkConfirmation(tx.safeTxHash, tx.owners, { owner: C, signature: sig(0) })).toBe('unverified')
  })

  test('an approved hash needs an on-chain check, and only for the owner it names', () => {
    expect(checkConfirmation(tx.safeTxHash, tx.owners, { owner: B, signature: sig(1) })).toBe('approved-hash')
    expect(checkConfirmation(tx.safeTxHash, tx.owners, { owner: A, signature: sig(1) })).toBe('unverified')
    expect(approvedHashCall(B, tx.safeTxHash).slice(0, 10)).toBe('0x7d832974')
  })

  test('contract signatures, non-owners, and missing signatures are never counted', () => {
    const contractSig = '0x' + A.slice(2).padStart(64, '0') + '41'.padStart(64, '0') + '00' + '20'.padStart(64, '0') + 'ab'.repeat(32)
    expect(checkConfirmation(tx.safeTxHash, tx.owners, { owner: A, signature: contractSig })).toBe('unverified')
    expect(checkConfirmation(tx.safeTxHash, [B, C], { owner: A, signature: sig(0) })).toBe('unverified')
    expect(checkConfirmation(tx.safeTxHash, tx.owners, { owner: A, signature: null })).toBe('unverified')
  })
})

describe('the document sent to the KeepKey', () => {
  test('hashes to the safeTxHash Safe published', () => {
    const doc = safeTypedData(Number(tx.chainId), tx.safe, tx.version, tx)
    const { EIP712Domain, ...types } = doc.types
    expect(EIP712Domain.map(f => f.name)).toEqual(['chainId', 'verifyingContract'])
    expect(ethers.utils._TypedDataEncoder.hash(doc.domain, types, doc.message)).toBe(tx.safeTxHash)
  })

  test('Safe 1.1.1 documents carry no chainId', () => {
    expect(safeTypedData(1, tx.safe, '1.1.1', tx).types.EIP712Domain.map(f => f.name)).toEqual(['verifyingContract'])
  })

  test('a signature over it verifies for the owner who made it, and only them', async () => {
    const owner = ethers.Wallet.createRandom()
    const doc = safeTypedData(Number(tx.chainId), tx.safe, tx.version, tx)
    const { EIP712Domain, ...types } = doc.types
    const raw = await owner._signTypedData(doc.domain, types, doc.message)
    const owners = [...tx.owners, owner.address]
    expect(checkConfirmation(tx.safeTxHash, owners, { owner: owner.address, signature: safeSignature(raw) })).toBe('verified')
    expect(checkConfirmation(tx.safeTxHash, owners, { owner: tx.owners[0], signature: safeSignature(raw) })).toBe('unverified')
  })

  test('v 0/1 signatures are normalised to 27/28, anything else is refused', () => {
    const sig = '0x' + '11'.repeat(64)
    expect(safeSignature(sig + '00').endsWith('1b')).toBe(true)
    expect(safeSignature(sig + '1c').endsWith('1c')).toBe(true)
    expect(() => safeSignature(sig)).toThrow('65-byte')
  })
})

test('read calls encode the standard Safe selectors', () => {
  expect(SAFE_READS.getOwners).toBe('0xa0e67e2b')
  expect(SAFE_READS.getThreshold).toBe('0xe75235b8')
  expect(SAFE_READS.nonce).toBe('0xaffed0e0')
  expect(SAFE_READS.VERSION).toBe('0xffa1ad74')
  expect(decodeSafeRead('getThreshold', '0x' + '3'.padStart(64, '0')).toString()).toBe('3')
})
