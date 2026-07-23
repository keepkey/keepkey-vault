import { describe, expect, test } from 'bun:test'
import { prioritizeExtraContracts, type PortfolioExtraContract } from '../src/bun/portfolio-extra-contracts'

const contract = (index: number): PortfolioExtraContract => ({
  networkId: 'eip155:1',
  contractAddress: `0x${index.toString(16).padStart(40, '0')}`,
  decimals: 18,
  symbol: `T${index}`,
})

describe('prioritizeExtraContracts', () => {
  test('keeps a swap destination ahead of Pioneers 20-contract cap', () => {
    const custom = Array.from({ length: 25 }, (_, index) => contract(index + 1))
    const destination = { ...custom[24], symbol: 'DEST' }
    const merged = prioritizeExtraContracts([destination], custom)

    expect(merged).toHaveLength(25)
    expect(merged[0]).toEqual(destination)
    expect(merged.slice(0, 20)).toContainEqual(destination)
  })

  test('deduplicates network and address case-insensitively', () => {
    const destination = contract(1)
    const duplicate = {
      ...destination,
      networkId: destination.networkId.toUpperCase(),
      contractAddress: destination.contractAddress.toUpperCase(),
    }
    expect(prioritizeExtraContracts([destination], [duplicate])).toEqual([destination])
  })
})
