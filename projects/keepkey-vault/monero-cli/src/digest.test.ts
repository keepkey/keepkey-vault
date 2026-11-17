import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { DigestWalletRpc, parseDigest } from './digest'

const username = 'public-fixture', password = 'public-fixture-password', realm = 'monero-rpc'
const md5 = (value: string) => createHash('md5').update(value).digest('hex')
const challenge = (algorithm: string, nonce = 'fixture-nonce') =>
  `Digest qop="auth",algorithm=${algorithm},realm="${realm}",nonce="${nonce}",stale=false`

/** Real HTTP fields reproduce Core's dual challenge headers and exercise the
 * client transport, selection, nonce counts and authenticated request bytes. */
async function fixture(headers: string | string[], nonce = 'fixture-nonce') {
  let requests = 0, authenticated = 0
  const algorithms: string[] = [], failures: string[] = []
  const server = createServer(async (request, response) => {
    requests++
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    if (!request.headers.authorization) {
      response.writeHead(401, { 'WWW-Authenticate': headers }); response.end(); return
    }
    try {
      const fields = parseDigest(request.headers.authorization)
      const initial = md5(`${username}:${realm}:${password}`)
      const ha1 = fields.algorithm === 'MD5-sess' ? md5(`${initial}:${nonce}:${fields.cnonce}`) : initial
      const expected = md5(`${ha1}:${nonce}:${fields.nc}:${fields.cnonce}:auth:${md5('POST:/json_rpc')}`)
      if (fields.username !== username || fields.realm !== realm || fields.nonce !== nonce || fields.uri !== '/json_rpc'
        || fields.response !== expected || fields.nc !== (authenticated + 1).toString(16).padStart(8, '0')) {
        throw new Error('Invalid fixture authentication')
      }
      authenticated++; algorithms.push(fields.algorithm)
      const value = JSON.parse(body)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { version: 65568 } }))
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'Fixture failed')
      response.writeHead(403); response.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen')
  const rpc = new DigestWalletRpc(address.port, username, password)
  return { rpc, algorithms, failures, counts: () => ({ requests, authenticated }),
    async close() { rpc.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

for (const coalesced of [false, true]) test(`Core's MD5/MD5-sess ${coalesced ? 'coalesced' : 'separate'} challenges authenticate repeated calls`, async () => {
  const fields = [challenge('MD5'), challenge('MD5-sess')]
  const f = await fixture(coalesced ? fields.join(', ') : fields)
  try {
    expect((await f.rpc.call('get_version')).version).toBe('65568')
    expect((await f.rpc.call('get_version')).version).toBe('65568')
    expect(f.counts()).toEqual({ requests: 3, authenticated: 2 })
    expect(f.failures).toEqual([])
  } finally { await f.close() }
})

test('unsupported challenge offers do not hide a supported MD5-sess alternative', async () => {
  const f = await fixture([challenge('SHA-256'), challenge('MD5-sess')])
  try {
    expect((await f.rpc.call('get_version')).version).toBe('65568')
    expect(f.algorithms).toEqual(['MD5-sess'])
    expect(f.failures).toEqual([])
  } finally { await f.close() }
})

test('quoted Digest-looking text in a nonce cannot split a coalesced header', async () => {
  const nonce = 'fixture, Digest quoted-text'
  const f = await fixture([challenge('MD5', nonce), challenge('MD5-sess', nonce)].join(', '), nonce)
  try {
    expect((await f.rpc.call('get_version')).version).toBe('65568')
    expect(f.counts()).toEqual({ requests: 2, authenticated: 1 })
    expect(f.failures).toEqual([])
  } finally { await f.close() }
})

test('duplicate fields remain invalid and cannot cause an authenticated request', async () => {
  const malformed = 'Digest realm="monero-rpc",realm="another",nonce="fixture-nonce",algorithm=MD5,qop="auth"'
  expect(() => parseDigest(malformed)).toThrow('Invalid local wallet RPC authentication')
  const f = await fixture(malformed)
  try {
    await expect(f.rpc.call('get_version')).rejects.toThrow('Invalid local wallet RPC authentication')
    expect(f.counts()).toEqual({ requests: 1, authenticated: 0 })
  } finally { await f.close() }
})
