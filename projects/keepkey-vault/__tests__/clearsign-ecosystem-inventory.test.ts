import { expect, test } from 'bun:test'
import { inventoryDiscovery } from '../src/bun/clearsign-ecosystem-inventory'

const address = '0x' + 'ab'.repeat(20)
const caip = `eip155:1/erc20:${address}`
const base = { assets: { [caip]: { symbol: 'TEST', decimals: 6 } }, denied: [],
  tokens: { [`1:${address}`]: { symbol: 'TEST', decimals: 6 } }, rpcChains: ['1'], certificateChains: [1] }
test('accounts for all assets without treating eligibility as device verification', () => {
  const result = inventoryDiscovery({ ...base, assets: { ...base.assets,
    'solana:main/token:Mint': { symbol: 'S', decimals: 9 }, 'cosmos:chain/denom:uatom': {},
    'bip122:chain/slip44:0': { symbol: 'BTC', decimals: 8 } } })
  expect(result.rows).toHaveLength(4)
  expect(result.summary.byStatus).toEqual({ denied: 1, 'needs-work': 2, 'eligible-on-demand': 1 })
  expect(result.summary.deviceVerifiedAssets).toBe(0)
})
test('denylist aliases cannot become eligible through another asset namespace', () => {
  const result = inventoryDiscovery({ ...base, denied: [`eip155:1/bep20:${address.toUpperCase().replace('0X', '0x')}`] })
  expect(result.rows[0].status).toBe('denied')
})
test('missing source metadata, certificates and RPC stay visible as independent blockers', () => {
  const result = inventoryDiscovery({ ...base, assets: { [caip]: { symbol: 'UNICODE♥' } }, rpcChains: [], certificateChains: [] })
  expect(result.rows[0].blockers).toContain('missing-or-unsupported-decimals')
  expect(result.rows[0].blockers).toContain('firmware-symbol-format')
  expect(result.rows[0].blockers).toContain('chain-certificate-missing')
  expect(result.rows[0].blockers).toContain('verification-rpc-missing')
  expect(result.rows[0].blockers).toContain('snapshot-identity-mismatch')
})
test('retired networks are denied instead of queued as live signing candidates', () => {
  const retired = 'binance:bnb-beacon-chain/slip44:60'
  const result = inventoryDiscovery({ ...base, assets: { [retired]: { symbol: 'BNB', decimals: 8 } } })
  expect(result.rows[0]).toMatchObject({ status: 'denied',
    blockers: expect.arrayContaining(['network-retired-no-new-blocks']) })
})
test('case-invalid Solana network identities are denied', () => {
  const invalid = 'solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp/slip44:501'
  const result = inventoryDiscovery({ ...base, assets: { [invalid]: { symbol: 'SOL', decimals: 9 } } })
  expect(result.rows[0]).toMatchObject({ status: 'denied',
    blockers: expect.arrayContaining(['invalid-network-identity']) })
})
test('nonnumeric SLIP-44 aliases are denied instead of entering an audit retry loop', () => {
  const invalid = 'cosmos:mayachain-mainnet-v1/slip44:maya'
  const result = inventoryDiscovery({ ...base, assets: { [invalid]: { symbol: 'MAYA', decimals: 4 } } })
  expect(result.rows[0]).toMatchObject({ status: 'denied',
    blockers: expect.arrayContaining(['invalid-slip44-identity']) })
})
