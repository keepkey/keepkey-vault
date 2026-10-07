import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { utils } from 'ethers'
import bs58 from 'bs58'
import { certifyPumpToken, certifySchemaTokens, inspectPumpToken, pumpTokenPreimage, TOKEN_2022 } from './solana-token'
import { CERTIFIED_SOLANA_CATALOG } from '../../src/bun/solana-certified-schema'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from '../../src/bun/solana-tx'
import joinFixture from '../../__tests__/fixtures/solana/soltoshidice-blackjack-join.json'
import ceeloFixture from '../../__tests__/fixtures/solana/soltoshidice-ceelo-bet.json'

const mint = '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump'
function account(m = mint, decimals = 6, symbol = 'SDICE') {
  return { executable: false, owner: TOKEN_2022, data: { program: 'spl-token-2022', parsed: { type: 'mint', info: {
    isInitialized: true, decimals, extensions: [
      { extension: 'metadataPointer', state: { authority: null, metadataAddress: m } },
      { extension: 'tokenMetadata', state: { mint: m, symbol, updateAuthority: null } },
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

test('the SoltoshiDICE entry pins the SDICE identity the real join names at account 3', () => {
  const { message, instruction } = realJoin()
  expect(CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin.token).toEqual({ mint, tokenProgram: TOKEN_2022, decimals: 6, symbol: 'SDICE' })
  expect(bs58.encode(message.staticAccounts[instruction.accountIndices[3]])).toBe(mint)
})

test('a failover provider that misreports SDICE gets nothing signed, and its answer is not cached', async () => {
  const { message, instruction } = realJoin()
  // Provider 1 is rate-limited, so provider 2 alone answers: the verified repro.
  const env = { CLEARSIGN_SOLANA_RPC_ENDPOINTS: 'https://pin-a.example,https://pin-b.example' }
  const join = (answer: () => unknown) => certifySchemaTokens(env, 'soltoshidiceBlackjackJoin',
    CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin, instruction, message.staticAccounts, '11'.repeat(32),
    (async (url: any) => url === 'https://pin-a.example'
      ? new Response('', { status: 429 })
      : Response.json({ result: { value: [answer()] } })) as typeof fetch)
  for (const lie of [() => account(mint, 9), () => account(mint, 6, 'USDC')]) {
    const result = await join(lie)
    expect(result.tokenInfo).toBeUndefined()
    expect(result.tokenMetadataStatus).toBe('detailed-review-required')
  }
  const honest = await join(() => account())
  expect(honest.tokenMetadataStatus).toBe('certified-on-chain')
  expect(honest.tokenInfo).toMatchObject([{ mint, symbol: 'SDICE', decimals: 6 }])
})

test('the SDICE pin holds whichever entry asks, as a token definition is not bound to a schema', async () => {
  // certifyPumpToken is the Pump AMM buy path.
  const fetcher = (async () => Response.json({ result: { value: [account(mint, 9)] } })) as typeof fetch
  expect(await certifyPumpToken({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://pin-pump.example' }, mint, '11'.repeat(32), fetcher)).toBeUndefined()
})

test('the SoltoshiDICE entry certifies no mint but SDICE, eligible or not', async () => {
  const { message, instruction } = realJoin()
  const other = bs58.encode(Buffer.alloc(32, 7))
  const accountKeys = [...message.staticAccounts]
  accountKeys[instruction.accountIndices[3]] = bs58.decode(other)
  let reads = 0
  const fetcher = (async () => { reads++; return Response.json({ result: { value: [account(other)] } }) }) as typeof fetch
  const result = await certifySchemaTokens({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://pin-other.example' }, 'soltoshidiceBlackjackJoin',
    CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin, instruction, accountKeys, '11'.repeat(32), fetcher)
  expect(reads).toBe(0)
  expect(result.tokenInfo).toBeUndefined()
  expect(result.tokenMetadataStatus).toBe('detailed-review-required')
})

test('an unpinned Pump mint is still certified from its on-chain identity', async () => {
  const other = bs58.encode(Buffer.alloc(32, 9))
  const fetcher = (async () => Response.json({ result: { value: [account(other, 9, 'PUMPY')] } })) as typeof fetch
  const token = await certifyPumpToken({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://unpinned.example' }, other, '11'.repeat(32), fetcher)
  expect(token).toMatchObject({ mint: other, tokenProgram: TOKEN_2022, decimals: 9, symbol: 'PUMPY' })
})

function realCeeloBet() {
  const full = Buffer.from(ceeloFixture.rawTxBase64, 'base64')
  const message = parseSolanaMessage(solanaMessageSlice(full, parseSolanaTx(full)))
  // Instruction 0 is the ComputeBudget companion; the bet is instruction 1.
  return { message, instruction: message.instructions[1] }
}
const CEELO = CERTIFIED_SOLANA_CATALOG.soltoshidiceCeeloBet

test('the Cee-lo entry pins the SDICE identity the real bet names at account 5', () => {
  const { message, instruction } = realCeeloBet()
  expect(CEELO.token).toEqual({ mint, tokenProgram: TOKEN_2022, decimals: 6, symbol: 'SDICE' })
  expect(CEELO.args!.filter(arg => arg.type === 6).map(arg => arg.mintAccount)).toEqual([5])
  expect(bs58.encode(message.staticAccounts[instruction.accountIndices[5]])).toBe(mint)
})

test('attests SDICE for the real Cee-lo wager, so the device shows an amount and a symbol', async () => {
  const { message, instruction } = realCeeloBet()
  const requested: string[][] = []
  const fetcher = (async (_url: any, init: any) => {
    requested.push(JSON.parse(init.body).params[0])
    return Response.json({ result: { value: [account()] } })
  }) as typeof fetch
  const result = await certifySchemaTokens({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://ceelo-test.example' }, 'soltoshidiceCeeloBet',
    CEELO, instruction, message.staticAccounts, '11'.repeat(32), fetcher)
  expect(requested).toEqual([[mint]])
  expect(result.tokenMetadataStatus).toBe('certified-on-chain')
  expect(result.tokenInfo).toMatchObject([{ mint, tokenProgram: TOKEN_2022, symbol: 'SDICE', decimals: 6, signerKeyId: 0x80 }])
})

test('a provider that misreports SDICE gets nothing signed for the Cee-lo wager either', async () => {
  const { message, instruction } = realCeeloBet()
  // Provider 1 is rate-limited, so provider 2 alone answers: the verified repro.
  const env = { CLEARSIGN_SOLANA_RPC_ENDPOINTS: 'https://ceelo-pin-a.example,https://ceelo-pin-b.example' }
  const bet = (answer: () => unknown) => certifySchemaTokens(env, 'soltoshidiceCeeloBet',
    CEELO, instruction, message.staticAccounts, '11'.repeat(32),
    (async (url: any) => url === 'https://ceelo-pin-a.example'
      ? new Response('', { status: 429 })
      : Response.json({ result: { value: [answer()] } })) as typeof fetch)
  for (const lie of [() => account(mint, 9), () => account(mint, 6, 'USDC')]) {
    const result = await bet(lie)
    expect(result.tokenInfo).toBeUndefined()
    expect(result.tokenMetadataStatus).toBe('detailed-review-required')
  }
  const honest = await bet(() => account())
  expect(honest.tokenMetadataStatus).toBe('certified-on-chain')
})

test('the Cee-lo entry certifies no mint but SDICE, so a swapped mint account is never labelled', async () => {
  const { message, instruction } = realCeeloBet()
  const other = bs58.encode(Buffer.alloc(32, 7))
  const accountKeys = [...message.staticAccounts]
  accountKeys[instruction.accountIndices[5]] = bs58.decode(other)
  let reads = 0
  const fetcher = (async () => { reads++; return Response.json({ result: { value: [account(other)] } }) }) as typeof fetch
  const result = await certifySchemaTokens({ CLEARSIGN_SOLANA_RPC_ENDPOINT: 'https://ceelo-other.example' }, 'soltoshidiceCeeloBet',
    CEELO, instruction, accountKeys, '11'.repeat(32), fetcher)
  expect(reads).toBe(0)
  expect(result.tokenInfo).toBeUndefined()
  expect(result.tokenMetadataStatus).toBe('detailed-review-required')
})
