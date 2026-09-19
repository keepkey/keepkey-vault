import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { utils } from 'ethers'
import bs58 from 'bs58'
import { certifyPumpToken, certifySchemaTokens, inspectPumpToken, pumpTokenPreimage, TOKEN_2022 } from './solana-token'
import { CERTIFIED_SOLANA_CATALOG } from '../../src/bun/solana-certified-schema'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from '../../src/bun/solana-tx'
import joinFixture from '../../__tests__/fixtures/solana/soltoshidice-blackjack-join.json'

const mint = '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump'
function account() {
  return { executable: false, owner: TOKEN_2022, data: { program: 'spl-token-2022', parsed: { type: 'mint', info: {
    isInitialized: true, decimals: 6, extensions: [
      { extension: 'metadataPointer', state: { authority: null, metadataAddress: mint } },
      { extension: 'tokenMetadata', state: { mint, symbol: 'SDICE', updateAuthority: null } },
    ],
  } } } }
}
test('attests immutable on-chain identity, including program and amount scale', async () => {
  const value = account()
  const key = '11'.repeat(32) // public test key; never a production credential
  const fetcher = (async (_url: any, init: any) => {
    expect(JSON.parse(init.body).params).toEqual([[mint], { encoding: 'jsonParsed', commitment: 'confirmed' }])
    return Response.json({ result: { value: [value] } })
  }) as typeof fetch
  const token = await certifyPumpToken({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://rpc.example' }, mint, key, fetcher)
  expect(token?.symbol).toBe('SDICE'); expect(token?.decimals).toBe(6); expect(token?.signerKeyId).toBe(128)
  const digest = createHash('sha256').update(pumpTokenPreimage(token!)).digest('hex')
  const signature = new utils.SigningKey(`0x${key}`).signDigest(`0x${digest}`)
  expect(token?.signature).toBe(signature.r.slice(2) + signature.s.slice(2))
  expect(pumpTokenPreimage({ ...token!, decimals: 9 })).not.toEqual(pumpTokenPreimage(token!))
})
test('cannot certify site labels, another mint, mutable metadata or transfer-affecting extensions', () => {
  expect(inspectPumpToken(null, mint)).toBeUndefined()
  for (const mutate of [
    (a: any) => a.owner = 'attacker',
    (a: any) => a.data.parsed.type = 'account',
    (a: any) => a.data.parsed.info.decimals = 10,
    (a: any) => a.data.parsed.info.extensions[0].state.metadataAddress = 'anotherMint',
    (a: any) => a.data.parsed.info.extensions[1].state.mint = 'anotherMint',
    (a: any) => a.data.parsed.info.extensions[1].state.updateAuthority = mint,
    (a: any) => a.data.parsed.info.extensions[1].state.symbol = 'USD\nAPPROVED',
    (a: any) => a.data.parsed.info.extensions.push({ extension: 'transferFeeConfig' }),
    (a: any) => a.data.parsed.info.extensions.push({ extension: 'transferHook' }),
  ]) {
    const a = account(); mutate(a); expect(inspectPumpToken(a, mint)).toBeUndefined()
  }
})

test('reuses verified immutable identity during RPC outages without caching a signing key', async () => {
  const env = { CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://cache-test.example' }
  let reads = 0
  const fetcher = (async () => {
    if (++reads > 1) throw new Error('RPC unavailable')
    return Response.json({ result: { value: [account()] } })
  }) as typeof fetch
  const first = await certifyPumpToken(env, mint, '11'.repeat(32), fetcher)
  const second = await certifyPumpToken(env, mint, '22'.repeat(32), fetcher)
  expect(reads).toBe(1)
  expect(second?.symbol).toBe(first?.symbol)
  expect(second?.signature).not.toBe(first?.signature)
})

function realJoin() {
  const full = Buffer.from(joinFixture.rawTxBase64, 'base64')
  const message = parseSolanaMessage(solanaMessageSlice(full, parseSolanaTx(full)))
  return { message, instruction: message.instructions[joinFixture.expected.instructionIndex] }
}

test('attests the SDICE mint once for all three TOKEN_AMOUNT args of the real SoltoshiDICE join', async () => {
  const { message, instruction } = realJoin()
  const key = '11'.repeat(32) // public test key; never a production credential
  const requested: string[][] = []
  const fetcher = (async (_url: any, init: any) => {
    requested.push(JSON.parse(init.body).params[0])
    return Response.json({ result: { value: [account()] } })
  }) as typeof fetch
  const result = await certifySchemaTokens({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://join-test.example' }, 'soltoshidiceBlackjackJoin',
    CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin, instruction, message.staticAccounts, key, fetcher)
  expect(requested).toEqual([[joinFixture.expected.mint]])
  expect(result.tokenMetadataStatus).toBe('certified-on-chain')
  expect(result.tokenInfo).toHaveLength(1)
  const token = result.tokenInfo![0]
  expect(token).toMatchObject({ mint: joinFixture.expected.mint, tokenProgram: TOKEN_2022, symbol: 'SDICE', decimals: 6, signerKeyId: 0x80 })
  // Preimage assembled independently: tag || mint || token program || le32 decimals || symbol.
  const preimage = Buffer.concat([Buffer.from('KeepKeySolanaTokenDef/2'), Buffer.from(bs58.decode(joinFixture.expected.mint)),
    Buffer.from(bs58.decode(TOKEN_2022)), Buffer.from([6, 0, 0, 0]), Buffer.from('SDICE')])
  const digest = createHash('sha256').update(preimage).digest('hex')
  const recovered = utils.recoverPublicKey(`0x${digest}`, { r: `0x${token.signature.slice(0, 64)}`, s: `0x${token.signature.slice(64)}`, v: 27 })
  const recoveredAlt = utils.recoverPublicKey(`0x${digest}`, { r: `0x${token.signature.slice(0, 64)}`, s: `0x${token.signature.slice(64)}`, v: 28 })
  expect([recovered, recoveredAlt]).toContain(new utils.SigningKey(`0x${key}`).publicKey)
})

test('an ineligible mint gets no token info, leaving the raw amount and mint on the device', async () => {
  const { message, instruction } = realJoin()
  const fetcher = (async () => {
    const a = account(); a.data.parsed.info.extensions.push({ extension: 'transferHook' } as any)
    return Response.json({ result: { value: [a] } })
  }) as typeof fetch
  const result = await certifySchemaTokens({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://join-hook.example' }, 'soltoshidiceBlackjackJoin',
    CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin, instruction, message.staticAccounts, '11'.repeat(32), fetcher)
  expect(result.tokenInfo).toBeUndefined()
  expect(result.tokenMetadataStatus).toBe('detailed-review-required')
})

test('a schema with no token amounts makes no token RPC call', async () => {
  const { message, instruction } = realJoin()
  const fetcher = (async () => { throw new Error('must not be called') }) as typeof fetch
  expect(await certifySchemaTokens({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://relay.example' }, 'relayDepositNative',
    CERTIFIED_SOLANA_CATALOG.relayDepositNative, instruction, message.staticAccounts, '11'.repeat(32), fetcher)).toEqual({})
})
