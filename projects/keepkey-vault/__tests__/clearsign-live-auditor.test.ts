import { afterEach, describe, expect, test } from 'bun:test'
import bs58 from 'bs58'
import { utils as ethersUtils } from 'ethers'

import { auditEvmIdentity, auditEvmTypedDataIdentity, auditSolanaIdentity } from '../src/bun/clearsign-live-auditor'
import { observeEvmCall, observeEvmTypedData } from '../src/bun/clearsign-observation'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function rpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
}

describe('live ClearSign identity auditor', () => {
  test('captures EVM implementation identity without treating it as trusted coverage', async () => {
    const contract = '0x1111111111111111111111111111111111111111'
    const implementation = '0x2222222222222222222222222222222222222222'
    const code = '0x6001600055'
    globalThis.fetch = (async (_url: any, init: any) => {
      if (!init?.body) return new Response(JSON.stringify({
        abi: [{ type: 'function', name: 'upgradeTo', inputs: [{ name: 'newImplementation', type: 'address' }] }],
        runtimeMatch: 'exact_match', verifiedAt: '2026-01-01T00:00:00Z',
      }), { headers: { 'content-type': 'application/json' } })
      const body = JSON.parse(init.body)
      if (body.method === 'eth_blockNumber') return rpcResult('0x123')
      if (body.method === 'eth_getStorageAt') {
        return rpcResult(body.params[1].startsWith('0x3608') ? `0x${'0'.repeat(24)}${implementation.slice(2)}` : `0x${'0'.repeat(64)}`)
      }
      if (body.method === 'eth_getCode') return rpcResult(code)
      throw new Error(body.method)
    }) as typeof fetch

    const evidence = await auditEvmIdentity(observeEvmCall({ chainId: 1, to: contract, data: '0x3659cfe6' }), 'https://rpc.example/secret-key')
    expect(evidence.endpoint).toBe('https://rpc.example')
    expect(evidence.stateReference).toBe('0x123')
    expect(evidence.identities).toEqual([
      { address: contract, role: 'contract', codeHash: ethersUtils.keccak256(code) },
      { address: implementation, role: 'implementation', codeHash: ethersUtils.keccak256(code) },
    ])
    expect(evidence.candidates?.[0]).toMatchObject({ source: 'sourcify', name: 'upgradeTo', signature: 'upgradeTo(address)', matchQuality: 'exact_match' })
    expect(evidence.limitations.join(' ')).toContain('does not prove')
  })

  test('discovers an active ERC-7730 descriptor only for exact context and selector', async () => {
    const contract = '0x1111111111111111111111111111111111111111'
    globalThis.fetch = (async (url: any, init: any) => {
      const target = String(url)
      if (target.endsWith('index.calldata.json')) return new Response(JSON.stringify({
        [`eip155:1:${contract}`]: 'registry/example/calldata-Token.json',
      }))
      if (target.endsWith('registry/example/calldata-Token.json')) return new Response(JSON.stringify({
        $schema: '../../specs/erc7730-v2.schema.json',
        context: { contract: { deployments: [{ chainId: 1, address: contract.toUpperCase() }] } },
        display: { formats: { 'transfer(address to,uint256 amount)': { intent: 'Send', fields: [] } } },
      }))
      if (target.startsWith('https://sourcify.dev/')) return new Response('{}', { status: 404 })
      const body = JSON.parse(init.body)
      if (body.method === 'eth_blockNumber') return rpcResult('0x456')
      if (body.method === 'eth_getCode') return rpcResult('0x6000')
      if (body.method === 'eth_getStorageAt' || body.method === 'eth_call') return rpcResult(`0x${'0'.repeat(64)}`)
      throw new Error(body.method)
    }) as typeof fetch
    const evidence = await auditEvmIdentity(
      observeEvmCall({ chainId: 1, to: contract, data: `0xa9059cbb${'00'.repeat(64)}` }),
      'https://rpc.example',
    )
    expect(evidence.candidates).toHaveLength(1)
    expect(evidence.candidates?.[0]).toMatchObject({
      source: 'erc7730-registry', name: 'transfer', signature: 'transfer(address,uint256)',
      selectorOrDiscriminator: '0xa9059cbb', matchQuality: 'erc7730-v2-active-registry',
      inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    })
    expect(evidence.candidates?.[0].provenance).toMatch(/parsed-json-sha256=[0-9a-f]{64}$/)
    expect(evidence.candidates?.[0].erc7730Display).toEqual({
      intent: 'Send', hasIncludes: false, requiredOrExcluded: false, fieldsTruncated: false, fields: [],
    })
    expect(evidence.limitations.join(' ')).toContain('still require promotion review')
  })

  test('reports ERC-7730 registry outage instead of claiming no descriptor exists', async () => {
    const contract = '0x1111111111111111111111111111111111111111'
    globalThis.fetch = (async (url: any, init: any) => {
      const target = String(url)
      if (target.endsWith('index.calldata.json')) throw new Error('registry offline')
      if (target.startsWith('https://sourcify.dev/')) return new Response('{}', { status: 404 })
      const body = JSON.parse(init.body)
      if (body.method === 'eth_blockNumber') return rpcResult('0x456')
      if (body.method === 'eth_getCode') return rpcResult('0x6000')
      if (body.method === 'eth_getStorageAt' || body.method === 'eth_call') return rpcResult(`0x${'0'.repeat(64)}`)
      throw new Error(body.method)
    }) as typeof fetch
    const evidence = await auditEvmIdentity(
      observeEvmCall({ chainId: 1, to: contract, data: '0xa9059cbb' }),
      'https://rpc.example',
    )
    expect(evidence.candidates).toEqual([])
    expect(evidence.limitations.join(' ')).toContain('discovery was unavailable')
    expect(evidence.limitations.join(' ')).not.toContain('No active-v2')
  })

  test('discovers EIP-712 metadata only by exact context, primary type, and encodeTypeHash', async () => {
    const contract = '0x1111111111111111111111111111111111111111'
    const types = { Permit: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }] }
    const encodeType = ethersUtils._TypedDataEncoder.from(types).encodeType('Permit')
    const typeHash = ethersUtils.id(encodeType)
    globalThis.fetch = (async (url: any, init: any) => {
      const target = String(url)
      if (target.endsWith('index.eip712.json')) return new Response(JSON.stringify({
        [`eip155:1:${contract}`]: { Permit: [{ path: 'registry/example/eip712-Permit.json', encodeTypeHashes: [typeHash] }] },
      }))
      if (target.endsWith('index.calldata.json')) return new Response('{}')
      if (target.endsWith('registry/example/eip712-Permit.json')) return new Response(JSON.stringify({
        $schema: '../../specs/erc7730-v2.schema.json',
        display: { formats: { [encodeType]: { intent: 'Permit spending', fields: [
          { path: 'spender', label: 'Spender', format: 'addressName' },
          { path: 'amount', label: 'Amount', format: 'raw' },
        ] } } },
      }))
      if (target.startsWith('https://sourcify.dev/')) return new Response('{}', { status: 404 })
      const body = JSON.parse(init.body)
      if (body.method === 'eth_blockNumber') return rpcResult('0x789')
      if (body.method === 'eth_getCode') return rpcResult('0x6000')
      if (body.method === 'eth_getStorageAt' || body.method === 'eth_call') return rpcResult(`0x${'0'.repeat(64)}`)
      throw new Error(body.method)
    }) as typeof fetch
    const draft = observeEvmTypedData({ typedData: {
      domain: { chainId: 1, verifyingContract: contract }, primaryType: 'Permit', types, message: {},
    } })
    const evidence = await auditEvmTypedDataIdentity(draft, 'https://rpc.example')
    expect(evidence.candidates).toHaveLength(1)
    expect(evidence.candidates?.[0]).toMatchObject({
      source: 'erc7730-registry', address: contract, name: 'Permit', signature: encodeType,
      selectorOrDiscriminator: typeHash.toLowerCase(), matchQuality: 'erc7730-v2-active-registry-eip712',
    })
    expect(evidence.candidates?.[0].provenance).toContain(`encodeTypeHash=${typeHash.toLowerCase()}`)
  })

  test('captures Solana program-data hash, deployment slot, and live upgrade authority', async () => {
    const program = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'
    const programData = bs58.encode(Buffer.alloc(32, 2))
    const authority = bs58.encode(Buffer.alloc(32, 3))
    const programState = Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.alloc(32, 2)])
    const dataState = Buffer.alloc(45)
    dataState.writeUInt32LE(3, 0)
    dataState.writeBigUInt64LE(99n, 4)
    dataState[12] = 1
    Buffer.alloc(32, 3).copy(dataState, 13)
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body)
      if (body.method === 'getSlot') return rpcResult(1234)
      const address = body.params[0]
      const bytes = address === program ? programState : dataState
      return rpcResult({ value: { data: [bytes.toString('base64'), 'base64'], owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: address === program } })
    }) as typeof fetch
    const draft: any = {
      chain: 'Solana', requestKind: 'solana-transaction', shapeKey: 'shape',
      shape: { components: [{ program, prefix1: '0d', prefix8: '0d9e0ddf5fd51c06' }] }, protectionLevel: 'P1', definitionSource: 'none',
    }
    const evidence = await auditSolanaIdentity(draft, 'https://solana.example/key')
    expect(evidence.endpoint).toBe('https://solana.example')
    expect(evidence.identities[1]).toMatchObject({ address: programData, role: 'program-data', deployedSlot: '99', upgradeAuthority: authority })
    expect(evidence.candidates?.[0]).toMatchObject({ source: 'program-registry', name: 'depositNative', selectorOrDiscriminator: '0d9e0ddf5fd51c06' })
    expect(evidence.limitations.join(' ')).toContain('remains upgradeable')
  })

  test('discovers a discriminator-matching canonical Program Metadata IDL as an untrusted candidate', async () => {
    const program = bs58.encode(Buffer.alloc(32, 0x44))
    const discriminator = '0102030405060708'
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).startsWith('https://idl-one.vercel.app/api/idl')) {
        return new Response(JSON.stringify({
          type: 'pmp', address: 'Metadata111', authority: 'Authority111',
          content: JSON.stringify({ instructions: [{
            name: 'enterTournament', discriminator: [...Buffer.from(discriminator, 'hex')],
            args: [{ name: 'buyIn', type: 'u64' }],
            accounts: [{ name: 'player', writable: true, signer: true }, { name: 'vault', writable: true }],
          }] }),
        }))
      }
      const body = JSON.parse(init.body)
      if (body.method === 'getSlot') return rpcResult(888)
      return rpcResult({ value: { data: [Buffer.from('program-code').toString('base64'), 'base64'], owner: 'LoaderV411111111111111111111111111111111111', executable: true } })
    }) as typeof fetch
    const draft: any = {
      chain: 'Solana', requestKind: 'solana-transaction', shapeKey: 'shape-idl',
      shape: { components: [{ program, prefix1: '01', prefix8: discriminator }] }, protectionLevel: 'P1', definitionSource: 'none',
    }
    const evidence = await auditSolanaIdentity(draft, 'https://api.mainnet-beta.solana.com')
    expect(evidence.candidates).toHaveLength(1)
    expect(evidence.candidates?.[0]).toMatchObject({
      source: 'anchor-idl', name: 'enterTournament', selectorOrDiscriminator: discriminator,
      inputs: [{ name: 'buyIn', type: 'u64' }],
      accounts: [{ name: 'player', writable: true, signer: true }, { name: 'vault', writable: true, signer: false }],
      matchQuality: 'canonical-program-metadata',
    })
    expect(evidence.candidates?.[0].provenance).toContain('authority=Authority111')
    expect(evidence.limitations.join(' ')).toContain('still require independent review')
  })
})
