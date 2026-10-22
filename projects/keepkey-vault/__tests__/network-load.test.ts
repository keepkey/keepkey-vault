import { describe, expect, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import { BASE_MS, NETWORK_MS, estimateLoadMs } from '../src/shared/network-load'

const pickable = CHAINS.filter(c => !c.hidden)

describe('network load estimate', () => {
  test('every pickable non-EVM network except Bitcoin has a measured cost', () => {
    const missing = pickable.filter(c => c.chainFamily !== 'evm' && c.id !== 'bitcoin' && !(c.id in NETWORK_MS))
    expect(missing.map(c => c.id)).toEqual([])
  })

  test('all on reproduces the measured 35.7 s load', () => {
    expect(Math.round(estimateLoadMs(pickable) / 100) / 10).toBe(35.7)
  })

  test('EVM networks and Bitcoin cost nothing to turn off; others do', () => {
    const all = estimateLoadMs(pickable)
    expect(estimateLoadMs(pickable.filter(c => c.chainFamily !== 'evm'))).toBe(all)
    expect(estimateLoadMs(pickable.filter(c => c.id !== 'litecoin'))).toBe(all - NETWORK_MS.litecoin)
    expect(estimateLoadMs([{ id: 'bitcoin' }])).toBe(BASE_MS)
  })
})
