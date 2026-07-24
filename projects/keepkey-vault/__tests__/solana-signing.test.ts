import { describe, expect, test } from 'bun:test'
import bs58 from 'bs58'
import { requiresSolanaBlindSigningConsent } from '../src/bun/solana-consent'
import { signSolanaWireTransaction } from '../src/bun/solana-signing'
import { SolanaSignRequest } from '../src/bun/schemas'

const SIGNER_0 = Buffer.alloc(32, 0x11)
const SIGNER_1 = Buffer.alloc(32, 0x22)
const NOT_A_SIGNER = Buffer.alloc(32, 0x33)
const ADDRESS_N = [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]

function solanaMessage(signers: Buffer[], versioned = false): Buffer {
  return Buffer.concat([
    ...(versioned ? [Buffer.from([0x80])] : []),
    Buffer.from([signers.length, 0, 0]), // header
    Buffer.from([signers.length]),       // static account count
    ...signers,
    Buffer.alloc(32, 0x44),              // recent blockhash
    Buffer.from([0]),                    // zero instructions
    ...(versioned ? [Buffer.from([0])] : []), // zero ALT entries
  ])
}

function wireTransaction(
  signers = [SIGNER_0],
  options: { versioned?: boolean; signatures?: Buffer[] } = {},
): { rawTx: string; message: Buffer } {
  const message = solanaMessage(signers, options.versioned)
  const signatures = options.signatures
    ?? signers.map(() => Buffer.alloc(64))
  return {
    rawTx: Buffer.concat([
      Buffer.from([signers.length]),
      ...signatures,
      message,
    ]).toString('base64'),
    message,
  }
}

describe('Solana transaction signing route', () => {
  test('REST schema preserves a complete descriptor but strips caller-asserted blind consent', () => {
    const swapMetadata = {
      payload: Buffer.from('KKSOLSW1-test').toString('base64'),
      signature: Buffer.alloc(64, 1).toString('base64'),
      signerKeyId: 3,
    }
    const parsed = SolanaSignRequest.parse({
      raw_tx: wireTransaction().rawTx,
      addressNList: ADDRESS_N,
      swapMetadata,
      allowBlindSigning: true,
    })
    expect(parsed.swapMetadata).toEqual(swapMetadata)
    expect('allowBlindSigning' in parsed).toBe(false)
  })

  test('REST schema rejects partial or out-of-range descriptors', () => {
    expect(() => SolanaSignRequest.parse({
      raw_tx: wireTransaction().rawTx,
      swapMetadata: { payload: 'S0tTT0xTVzE=', signerKeyId: 3 },
    })).toThrow()
    expect(() => SolanaSignRequest.parse({
      raw_tx: wireTransaction().rawTx,
      swapMetadata: { payload: 'S0tTT0xTVzE=', signature: 'AA==', signerKeyId: 4 },
    })).toThrow()
  })

  test('opaque REST policy requires UI consent unless transaction-bound metadata is present', () => {
    const systemTransfer = {
      version: 'legacy',
      staticAccountCount: 3,
      instructions: [{
        status: 'known',
        programId: '11111111111111111111111111111111',
        programName: 'System Program',
        instructionName: 'transfer',
        args: [],
        accounts: [{ pubkey: 'source' }, { pubkey: 'destination' }],
      }],
      altPubkeys: [],
    } as const
    expect(requiresSolanaBlindSigningConsent(undefined, false)).toBe(true)
    expect(requiresSolanaBlindSigningConsent({
      ...systemTransfer,
      instructions: [{ ...systemTransfer.instructions[0], status: 'unknown-program' }],
    }, false)).toBe(true)
    expect(requiresSolanaBlindSigningConsent(systemTransfer, false)).toBe(false)
    expect(requiresSolanaBlindSigningConsent({
      ...systemTransfer,
      instructions: [{
        ...systemTransfer.instructions[0],
        instructionName: 'createAccount',
      }],
    }, false)).toBe(true)
    expect(requiresSolanaBlindSigningConsent({
      ...systemTransfer,
      instructions: [{
        ...systemTransfer.instructions[0],
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        programName: 'SPL Token',
        instructionName: 'transfer',
      }],
    }, false)).toBe(true)
    expect(requiresSolanaBlindSigningConsent({
      ...systemTransfer,
      version: 'v0',
      altPubkeys: ['lookup-table'],
    }, false)).toBe(true)
    expect(requiresSolanaBlindSigningConsent(undefined, true)).toBe(false)
  })

  test('routes v0 through SolanaSignTx and preserves internal one-shot/metadata parameters', async () => {
    let deviceRequest: any
    let messageCalls = 0
    const signature = Uint8Array.from({ length: 64 }, (_, i) => i)
    const wallet = {
      solanaSignTx: async (request: any) => {
        deviceRequest = request
        return { signature }
      },
      solanaSignMessage: async () => {
        messageCalls++
        throw new Error('v0 transaction must not use message signing')
      },
    }
    const swapMetadata = {
      payload: Buffer.from('KKSOLSW1-test').toString('base64'),
      signature: Buffer.alloc(64, 1).toString('base64'),
      signerKeyId: 1,
    }
    const wire = wireTransaction([SIGNER_0], { versioned: true })
    const unsignedTx = {
      addressNList: ADDRESS_N,
      rawTx: wire.rawTx,
      allowBlindSigning: true,
      swapMetadata,
    }
    const result = await signSolanaWireTransaction(
      unsignedTx,
      (request) => wallet.solanaSignTx(request),
      async () => bs58.encode(SIGNER_0),
    )

    expect(messageCalls).toBe(0)
    expect(Buffer.from(deviceRequest.rawTx, 'base64')).toEqual(wire.message)
    expect(deviceRequest.allowBlindSigning).toBe(true)
    expect(deviceRequest.swapMetadata).toEqual(swapMetadata)
    expect(Buffer.from(result.signature)).toEqual(Buffer.from(signature))
    expect(Buffer.from(result.serializedTx, 'base64').subarray(1, 65)).toEqual(Buffer.from(signature))
  })

  test('routes legacy transactions through the same transaction API', async () => {
    let deviceRequest: any
    const wallet = {
      solanaSignTx: async (request: any) => {
        deviceRequest = request
        return { signature: Buffer.alloc(64, 0x7f) }
      },
    }
    const wire = wireTransaction()
    await signSolanaWireTransaction({
      addressNList: ADDRESS_N,
      rawTx: wire.rawTx,
    }, (request) => wallet.solanaSignTx(request), async () => bs58.encode(SIGNER_0))
    expect(Buffer.from(deviceRequest.rawTx, 'base64')).toEqual(wire.message)
  })

  test('multisig signing writes the derived wallet slot and preserves an existing cosigner', async () => {
    const cosignerSignature = Buffer.alloc(64, 0xa5)
    const walletSignature = Buffer.alloc(64, 0x5a)
    const wire = wireTransaction([SIGNER_0, SIGNER_1], {
      signatures: [cosignerSignature, Buffer.alloc(64)],
    })

    const result = await signSolanaWireTransaction({
      addressNList: ADDRESS_N,
      rawTx: wire.rawTx,
    }, async () => ({ signature: walletSignature }), async () => bs58.encode(SIGNER_1))

    const signed = Buffer.from(result.serializedTx, 'base64')
    expect(signed.subarray(1, 65)).toEqual(cosignerSignature)
    expect(signed.subarray(65, 129)).toEqual(walletSignature)
  })

  test('refuses to sign when the derived wallet is not a required signer', async () => {
    let signCalls = 0
    const wire = wireTransaction([SIGNER_0, SIGNER_1])
    await expect(signSolanaWireTransaction({
      addressNList: ADDRESS_N,
      rawTx: wire.rawTx,
    }, async () => {
      signCalls++
      return { signature: Buffer.alloc(64) }
    }, async () => bs58.encode(NOT_A_SIGNER))).rejects.toThrow('not a required transaction signer')
    expect(signCalls).toBe(0)
  })
})
