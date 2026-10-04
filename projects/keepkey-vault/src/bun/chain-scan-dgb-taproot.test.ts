import { describe, expect, it } from 'bun:test'
import { supportsDgbTaproot, utxoAccountScriptPaths } from './chain-scan'
import { utxoDiscoveryKey } from './btc-backend/types'

const DGB = {
  id: 'digibyte',
  defaultPath: [0x80000000 + 44, 0x80000000 + 20, 0x80000000, 0, 0],
  scriptType: 'p2pkh',
} as any

describe('DigiByte Taproot account discovery', () => {
  it.each([
    [false, '7.17.0', false],
    [true, undefined, false],
    [true, 'not-a-version', false],
    [true, '7.16.9', false],
    [true, '7.17.0', true],
    [true, '7.18.1-alpha.1', true],
  ] as const)('gates flag=%s firmware=%s as %s', (flag, firmware, expected) => {
    expect(supportsDgbTaproot(flag, firmware)).toBe(expected)
  })

  it('fails closed when the firmware capability gate is off', () => {
    expect(utxoAccountScriptPaths(DGB, 0).map((entry) => entry.scriptType)).toEqual(['p2pkh'])
  })

  it('adds exactly the BIP86 account when the 7.17 gate is on', () => {
    const paths = utxoAccountScriptPaths(DGB, 0, false, true)
    expect(paths).toEqual([
      { scriptType: 'p2pkh', path: [0x80000000 + 44, 0x80000000 + 20, 0x80000000] },
      { scriptType: 'p2tr', path: [0x80000000 + 86, 0x80000000 + 20, 0x80000000] },
    ])
  })

  it('wraps only the Taproot xpub for Blockbook discovery', () => {
    expect(utxoDiscoveryKey('xpub-example', 'p2tr')).toBe('tr(xpub-example)')
    expect(utxoDiscoveryKey('xpub-example', 'p2pkh')).toBe('xpub-example')
  })
})
