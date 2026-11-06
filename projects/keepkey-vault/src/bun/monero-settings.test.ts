import { describe, expect, test } from 'bun:test'
import { validateMoneroNode } from './monero-settings'
describe('Monero daemon settings', () => {
  test('remote HTTPS and explicit loopback HTTP have a consistent origin', () => {
    expect(validateMoneroNode({ daemonUrl: 'https://xmr.example/', restoreHeight: 42 })).toEqual({ daemonUrl: 'https://xmr.example', restoreHeight: 42 })
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) expect(validateMoneroNode({ daemonUrl: `http://${host}:18081`, restoreHeight: 0 }).restoreHeight).toBe(0)
  })
  test('remote cleartext, credentials, paths and URL decorations are refused', () => {
    for (const daemonUrl of ['http://remote.example', 'https://user:password@example.org', 'https://xmr.example/wallet', 'https://xmr.example?q=secret', 'https://xmr.example/#secret', 'file:///wallet']) {
      expect(() => validateMoneroNode({ daemonUrl, restoreHeight: 0 })).toThrow()
    }
  })
  test('restore height cannot silently round, become negative or select the wrong scan range', () => {
    for (const restoreHeight of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateMoneroNode({ daemonUrl: 'https://xmr.example', restoreHeight })).toThrow()
  })
})
