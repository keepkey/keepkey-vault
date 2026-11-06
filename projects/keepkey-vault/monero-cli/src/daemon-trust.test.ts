import { expect, test } from 'bun:test'
import { walletDaemonArgs } from './wallet'

// wallet-rpc answers import_key_images with "This command requires a trusted daemon." otherwise.
test('a loopback daemon is trusted so key images can be imported', () => {
  expect(walletDaemonArgs('http://127.0.0.1:18081', { regtest: false })).toEqual(
    ['--trusted-daemon', '--daemon-address', 'http://127.0.0.1:18081', '--daemon-ssl', 'disabled'])
})

test('a remote daemon stays untrusted and pinned', () => {
  expect(walletDaemonArgs('https://node.example', { fingerprint: 'ab'.repeat(32), regtest: false })).toEqual(
    ['--untrusted-daemon', '--daemon-address', 'https://node.example', '--daemon-ssl', 'enabled', '--daemon-ssl-allowed-fingerprints', 'ab'.repeat(32)])
})
