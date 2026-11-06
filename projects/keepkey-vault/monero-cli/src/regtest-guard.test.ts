import { expect, test } from 'bun:test'
import { verifyDaemon } from './wallet'

// Without KEEPKEY_MONERO_LOCAL_REGTEST=1 a loopback regtest ("fakechain") daemon is refused.
test('a regtest daemon is refused unless the local-regtest switch is set', async () => {
  expect(process.env.KEEPKEY_MONERO_LOCAL_REGTEST).toBeUndefined()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ result:
    { nettype: 'fakechain', offline: true, synchronized: true, height: 200, testnet: false, stagenet: false } }) })
  try { await expect(verifyDaemon(`http://127.0.0.1:${server.port}`, 0)).rejects.toThrow('mainnet') }
  finally { server.stop(true) }
})
