const assert = require('node:assert/strict')
const { VaultClient } = require('../lib/client')

async function main() {
  const realFetch = global.fetch
  const realTimeout = AbortSignal.timeout
  const budgets = []
  try {
    AbortSignal.timeout = ms => { budgets.push(ms); return new AbortController().signal }
    global.fetch = async () => new Response('{}', {status: 200})
    const client = new VaultClient('http://vault.test', 'key')
    client.timeoutMs = 30_000
    client.signingTimeoutMs = 600_000
    for (const path of ['/eth/sign', '/eth/sign-transaction', '/eth/sign-typed-data', '/utxo/sign-transaction', '/solana/sign-message', '/cosmos/sign-amino', '/system/sign-identity', '/eth/sign-transaction?request=test']) {
      budgets.length = 0
      await client.post(path, {})
      assert.deepEqual(budgets, [600_000], path)
    }
    for (const path of ['/eth/verify', '/addresses/eth', '/api/v2/tx/broadcast']) {
      budgets.length = 0
      await client.post(path, {})
      assert.deepEqual(budgets, [30_000], path)
    }
    budgets.length = 0
    await client.post('/eth/sign', {}, 1234)
    assert.deepEqual(budgets, [1234], 'explicit override wins')
    budgets.length = 0
    await client.get('/api/health')
    assert.deepEqual(budgets, [30_000], 'reads retain their default')

    let calls = 0
    global.fetch = async () => ++calls === 1 ? new Response('Unauthorized', {status: 401}) : new Response(calls === 2 ? '{"apiKey":"new-key"}' : '{}', {status: 200})
    budgets.length = 0
    await client.post('/eth/sign-typed-data', {})
    assert.deepEqual(budgets, [600_000, 600_000, 600_000], 'signing budget survives authentication retry')
    budgets.length = 0
    await client.postBytes('/solana/sign-transaction', {})
    assert.deepEqual(budgets, [600_000], 'binary signing routes use the same budget')
    console.log('client timeouts: signing routes, auth retry, binary responses and explicit overrides passed')
  } finally {
    global.fetch = realFetch
    AbortSignal.timeout = realTimeout
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
