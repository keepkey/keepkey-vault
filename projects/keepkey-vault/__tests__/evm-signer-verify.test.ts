import { describe, expect, test } from 'bun:test'
import { ethers } from 'ethers'
import { EvmSignerVerificationError, verifyEvmSigner } from '../src/bun/evm-rpc'

// Fixed key so the expectations below are stable; funds never touch this.
const TEST_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const wallet = new ethers.Wallet(TEST_KEY)

/** A type-2 tx with calldata large enough to require multi-chunk transport. */
async function signLargeCalldataTx(): Promise<string> {
  return wallet.signTransaction({
    to: '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca',
    value: 0,
    nonce: 495,
    gasLimit: ethers.BigNumber.from('0x6c8b8'),
    maxFeePerGas: ethers.BigNumber.from('0x291d5740f'),
    maxPriorityFeePerGas: ethers.BigNumber.from('0x218711a00'),
    chainId: 1,
    type: 2,
    data: '0x3593564c' + '00'.repeat(1600),
  })
}

describe('verifyEvmSigner', () => {
  test('accepts a signature that recovers to the expected account', async () => {
    const signed = await signLargeCalldataTx()
    await expect(verifyEvmSigner(signed, wallet.address)).resolves.toBeUndefined()
  })

  test('accepts a checksum-mismatched expectation (case-insensitive compare)', async () => {
    const signed = await signLargeCalldataTx()
    await expect(verifyEvmSigner(signed, wallet.address.toLowerCase())).resolves.toBeUndefined()
  })

  test('rejects when the signature recovers to a different account', async () => {
    // This is the firmware 7.x.0–7.14.0 EIP-1559 chunked-data failure in
    // miniature: the bytes are a perfectly valid signature, they just do not
    // belong to the account we asked to sign. Broadcasting is accepted by the
    // RPC and then dropped from the mempool forever, so it must throw here.
    const signed = await signLargeCalldataTx()
    const someoneElse = ethers.Wallet.createRandom().address

    await expect(verifyEvmSigner(signed, someoneElse)).rejects.toBeInstanceOf(EvmSignerVerificationError)
    await expect(verifyEvmSigner(signed, someoneElse)).rejects.toThrow(/recovered signer/i)
    await expect(verifyEvmSigner(signed, someoneElse)).rejects.toThrow(/7\.14\.1/)
  })

  test('rejects unparseable bytes rather than letting them through', async () => {
    await expect(verifyEvmSigner('0xdeadbeef', wallet.address)).rejects.toBeInstanceOf(EvmSignerVerificationError)
    await expect(verifyEvmSigner('0xdeadbeef', wallet.address)).rejects.toThrow(/could not be parsed/i)
  })
})
