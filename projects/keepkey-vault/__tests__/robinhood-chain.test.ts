import { describe, expect, test } from 'bun:test'
import assetData from '../src/shared/assetData.json'
import { CHAINS } from '../src/shared/chains'

const ROBINHOOD_CAIP = 'eip155:4663/slip44:60'

describe('Robinhood Chain registry', () => {
  test('uses official mainnet identifiers and native ETH consistently', () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'robinhood')
    expect(chain).toBeDefined()
    expect(chain?.networkId).toBe('eip155:4663')
    expect(chain?.caip).toBe(ROBINHOOD_CAIP)
    expect(chain?.chainId).toBe('4663')
    expect(chain?.symbol).toBe('ETH')
    expect((assetData as Record<string, { symbol?: string }>)[ROBINHOOD_CAIP]?.symbol).toBe('ETH')
  })

  test('uses the standard Ethereum derivation path and official explorer', () => {
    const chain = CHAINS.find((candidate) => candidate.id === 'robinhood')!
    expect(chain.defaultPath).toEqual([0x8000002C, 0x8000003C, 0x80000000, 0, 0])
    expect(chain.explorerTxUrl).toBe('https://robinhoodchain.blockscout.com/tx/{{txid}}')
    expect(chain.explorerAddressUrl).toBe('https://robinhoodchain.blockscout.com/address/{{address}}')
  })
})
