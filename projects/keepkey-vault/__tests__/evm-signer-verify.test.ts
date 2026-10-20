import { afterEach, describe, expect, test } from 'bun:test'
import { ethers } from 'ethers'
import { EvmSignerVerificationError, verifyEvmSigner } from '../src/bun/evm-rpc'

// Fixed key so the expectations below are stable; funds never touch this.
const TEST_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const wallet = new ethers.Wallet(TEST_KEY)
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

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

describe('WalletConnect fee expiry during device confirmation (#508)', () => {
  async function runSign(baseFees: Array<string | undefined>, opts: { broadcast?: boolean; priority?: string; suggested?: string; legacy?: boolean } = {}) {
    // No real service, account, device or broadcast is used by this test.
    globalThis.fetch = (async () => Response.json({ error: { message: 'test service unavailable' } })) as unknown as typeof fetch
    const { WalletConnectManager } = await import('../src/bun/walletconnect')
    const sent: any[] = [], rpc: string[] = [], dismissed: string[] = []
    const manager: any = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: wallet.address, addressIndex: 0 }),
      getFirmwareVersion: () => '7.14.1',
      getAdvancedModeEnabled: () => false,
      getEvmSimulationEndpoint: () => 'http://127.0.0.1:9',
      recordClearSignObservation: () => undefined,
      requestSigningApproval: async () => true,
      dismissSigning: (id: string) => dismissed.push(id),
      log: () => {},
      ethSignTx: async (msg: any) => {
        sent.push(structuredClone(msg))
        return { serialized: await wallet.signTransaction({
          to: msg.to, value: msg.value, data: msg.data, nonce: Number(msg.nonce),
          gasLimit: msg.gasLimit, chainId: msg.chainId,
          ...(msg.maxFeePerGas ? { type: 2, maxFeePerGas: msg.maxFeePerGas, maxPriorityFeePerGas: msg.maxPriorityFeePerGas === '0x' ? '0x0' : msg.maxPriorityFeePerGas } : { gasPrice: msg.gasPrice }),
        }) }
      },
    } as any)
    manager.rpcCall = async (_chain: number, method: string) => {
      rpc.push(method)
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: baseFees.shift() }
      if (method === 'eth_maxPriorityFeePerGas') {
        if (opts.suggested === undefined) throw new Error('no suggestion')
        return opts.suggested
      }
      if (method === 'eth_sendRawTransaction') return '0xtesthash'
      throw new Error(`Unexpected RPC ${method}`)
    }
    const run = manager.signTransaction({
      from: wallet.address, to: '0x1111111111111111111111111111111111111111',
      value: '0x0', data: '0x', nonce: '0x0', gas: '0x5208', chainId: 42161,
      ...(opts.legacy ? { gasPrice: '0x131AA00' } : { maxFeePerGas: '20032000', ...(opts.priority === undefined ? {} : { maxPriorityFeePerGas: opts.priority }) }),
    }, [0x8000002c, 0x8000003c, 0x80000000, 0, 0], 'test dApp', 42161, opts.broadcast ?? true)
    return { run, sent, rpc, dismissed }
  }

  test('stale cap stops before the device is asked to sign', async () => {
    const cap = await runSign(['20186000'])
    await expect(cap.run).rejects.toThrow('Refresh the transaction')
    expect(cap.sent).toHaveLength(0)
    expect(cap.rpc).not.toContain('eth_sendRawTransaction')
    expect(cap.dismissed).toHaveLength(1)
  })

  test.each([true, false])('base fee rising during confirmation prevents releasing signed bytes (broadcast=%s)', async broadcast => {
    const cap = await runSign(['20000000', '20186000'], { broadcast })
    await expect(cap.run).rejects.toThrow('below the current network base fee')
    expect(cap.sent).toHaveLength(1)
    expect(cap.sent[0].maxFeePerGas).toBe('20032000')
    expect(cap.rpc).not.toContain('eth_sendRawTransaction')
    expect(cap.dismissed).toHaveLength(1)
  })

  test('missing tip suggestion uses zero rather than an invalid fixed 1.5 gwei', async () => {
    const cap = await runSign(['20000000', '20000000'])
    await expect(cap.run).resolves.toBe('0xtesthash')
    expect(cap.sent[0].maxPriorityFeePerGas).toBe('0x')
    expect(cap.sent[0].maxFeePerGas).toBe('20032000')
  })

  test('network-suggested priority fee is bounded by the approved cap', async () => {
    const cap = await runSign(['20000000', '20000000'], { suggested: '1500000000' })
    await expect(cap.run).resolves.toBe('0xtesthash')
    expect(cap.sent[0].maxPriorityFeePerGas).toBe('20032000')
  })

  test('an explicitly invalid dApp priority fee is rejected', async () => {
    const cap = await runSign(['20000000'], { priority: '1500000000' })
    await expect(cap.run).rejects.toThrow('priority fee')
    expect(cap.sent).toHaveLength(0)
  })

  test('a missing base fee cannot be treated as verified', async () => {
    const cap = await runSign([undefined])
    await expect(cap.run).rejects.toThrow('Cannot verify')
    expect(cap.sent).toHaveLength(0)
  })

  test('legacy transactions do not require an EIP-1559 base fee', async () => {
    const cap = await runSign([], { legacy: true })
    await expect(cap.run).resolves.toBe('0xtesthash')
    expect(cap.rpc).toEqual(['eth_sendRawTransaction'])
  })
})

describe('WalletConnect RPC failures (#123)', () => {
  test.each([
    [429, 'Too many connections', 'HTTP 429'],
    [200, 'Too many connections', 'non-JSON response'],
    [200, '{"jsonrpc":"2.0"}', 'returned no result'],
    [200, 'null', 'invalid response'],
    [200, '{"error":{"message":"rate limited"}}', 'rate limited'],
  ])('reports a useful failure for HTTP %s / %s', async (status, body, expected) => {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch
    const { WalletConnectManager } = await import('../src/bun/walletconnect')
    const manager: any = new WalletConnectManager({} as any)
    await expect(manager.rpcCall(1, 'eth_gasPrice', [])).rejects.toThrow(expected)
  })

  test('preserves a legitimate null result', async () => {
    globalThis.fetch = (async () => Response.json({ jsonrpc: '2.0', result: null })) as unknown as typeof fetch
    const { WalletConnectManager } = await import('../src/bun/walletconnect')
    const manager: any = new WalletConnectManager({} as any)
    await expect(manager.rpcCall(1, 'eth_getTransactionReceipt', ['0x00'])).resolves.toBeNull()
  })
})
