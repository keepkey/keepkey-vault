/**
 * Coverage observations on every signing path, at the level the device
 * actually shows: in-app swaps (vault-swap), REST, and WalletConnect messages
 * and Cosmos sign docs. Fixtures are real requests (fixtures/clearsign-
 * observation/real-requests.json, each with its _source). Rows go to a fresh
 * database in a temp dir; simulations go to a closed local port.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bs58 from 'bs58'
import fx from './fixtures/clearsign-observation/real-requests.json'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-cs-observation-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { protectSwapSignature, evmShownNatively, solanaShownNatively, recordVaultRpcEvmCall, recordVaultRpcSolanaTransaction, observeVaultRpcSignature } = await import('../src/bun/clearsign-native')
const { ActionCancelled } = await import('@keepkey/hdwallet-core')
const { observeEvmCall, observeSigningInfo } = await import('../src/bun/clearsign-observation')
const { SIGNING_ROUTES } = await import('../src/bun/signing-routes')
const { startRestApi } = await import('../src/bun/rest-api')
const { WalletConnectManager } = await import('../src/bun/walletconnect')

const FW = '7.16.0'
const CLOSED = 'http://127.0.0.1:9/'
const ETH_PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]

beforeAll(() => { db.initDb() })
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { db.getDb()!.run('DELETE FROM clearsign_observations') })

type Row = { source: string; chain: string; request_kind: string; protection_level: string; definition_source: string; outcome: string; shape_json: string; authenticated_component_count: number }
const rows = () => db.getDb()!.query(
  `SELECT source, chain, request_kind, protection_level, definition_source, outcome, shape_json, authenticated_component_count
     FROM clearsign_observations ORDER BY created_at, rowid`,
).all() as Row[]

describe('vault-swap: one row per swap signature, at the level the device shows', () => {
  const swap = (input: { chainFamily: any; chainId?: string; tx: any }, opts: { passphrase?: boolean; fw?: string } = {}) =>
    protectSwapSignature({
      isPassphraseWallet: () => opts.passphrase === true,
      firmwareVersion: () => opts.fw ?? FW,
      deviceId: () => 'cs-observation-test',
      evmEndpoint: () => CLOSED,
      solanaEndpoint: () => CLOSED,
    }, { from: '0x0000000000000000000000000000000000000001', kind: 'swap', ...input }, async () => ({ serialized: '0xf8' }))
  const evm = (t: { chainId: number; to: string; data: string; value: string }) => ({ chainFamily: 'evm', tx: { chainId: t.chainId, to: t.to, data: t.data, value: t.value } })

  test('a THORChain router deposit the firmware decodes is native, not P1', async () => {
    await swap(evm(fx.evmThorchainDeposit))
    expect(rows()).toMatchObject([{ source: 'vault-swap', chain: 'Ethereum', protection_level: 'P4', definition_source: 'native', outcome: 'signed', authenticated_component_count: 1 }])
  })

  test('a USDT transfer the firmware token table knows is native', async () => {
    await swap(evm(fx.evmUsdtTransfer))
    expect(rows()).toMatchObject([{ protection_level: 'P4', definition_source: 'native' }])
  })

  test('a plain ETH send is native', async () => {
    await swap(evm({ ...fx.evmNativeSend, data: '0x' }))
    expect(rows()).toMatchObject([{ protection_level: 'P4', definition_source: 'native' }])
  })

  test('a call the firmware cannot decode stays below P4', async () => {
    await swap(evm(fx.evmSwapNotNative))
    expect(rows()).toMatchObject([{ protection_level: 'P1', definition_source: 'none' }])
  })

  test('a Solana transfer the device reviews is native; one it does not review is not', async () => {
    await swap({ chainFamily: 'solana', tx: { rawTx: fx.solanaNativeSend.rawTxBase64 } })
    await swap({ chainFamily: 'solana', tx: { rawTx: fx.solanaNotReviewed.rawTxBase64 } })
    expect(rows().map((r) => [r.chain, r.protection_level, r.definition_source])).toEqual([
      ['Solana', 'P4', 'native'], ['Solana', 'P1', 'none'],
    ])
  })

  test('a native THORChain MsgDeposit swap is recorded too (it used to skip the observation)', async () => {
    await swap({ chainFamily: 'cosmos', chainId: 'thorchain-1', tx: { signDoc: fx.thorchainAminoDeposit.signDoc } })
    expect(rows()).toMatchObject([{ chain: 'THORChain', request_kind: 'transaction', protection_level: 'P4', definition_source: 'native', outcome: 'signed' }])
    expect(rows()[0].shape_json).not.toContain('BSC.USDT')
  })

  test('Tron: a TRX transfer and a USDT transfer are native on 7.16; a TRC-20 outside the table is not', async () => {
    await swap({ chainFamily: 'tron', tx: { rawTx: fx.tronTrxTransfer.rawDataHex } })
    await swap({ chainFamily: 'tron', tx: { rawTx: fx.tronUsdtTransfer.rawDataHex } })
    await swap({ chainFamily: 'tron', tx: { rawTx: fx.tronTrc20OutsideTable.rawDataHex } })
    expect(rows().map((r) => [r.chain, r.protection_level, r.definition_source])).toEqual([
      ['Tron', 'P4', 'native'], ['Tron', 'P4', 'native'], ['Tron', 'P1', 'none'],
    ])
  })

  test('Tron on 7.14.3 (no raw_data parser) is never native', async () => {
    await swap({ chainFamily: 'tron', tx: { rawTx: fx.tronUsdtTransfer.rawDataHex } }, { fw: '7.14.3' })
    expect(rows()).toMatchObject([{ chain: 'Tron', protection_level: 'P1' }])
  })

  test('TON is never native; a Hive transfer is', async () => {
    await swap({ chainFamily: 'ton', tx: { rawTx: fx.tonTransfer.rawTx } })
    await swap({ chainFamily: 'hive', tx: {} })
    expect(rows().map((r) => [r.chain, r.protection_level])).toEqual([['TON', 'P1'], ['Hive', 'P4']])
  })

  test('a hidden (passphrase) wallet records nothing', async () => {
    await swap(evm(fx.evmThorchainDeposit), { passphrase: true })
    expect(rows()).toEqual([])
  })
})

describe('vault-rpc: Desktop signers record a row at the level the device shows', () => {
  const ctx = (opts: { passphrase?: boolean } = {}) => ({
    isPassphraseWallet: () => opts.passphrase === true, firmwareVersion: () => FW, deviceId: () => 'cs-observation-test',
  })
  const evmCall = (t: any) => recordVaultRpcEvmCall(ctx(), {
    params: { chainId: t.chainId, to: t.to, data: t.data, value: t.value }, source: 'none', definitionResolution: 'not-checked', evmEndpoint: () => CLOSED,
  })

  test('ethSignTx: THOR deposit, USDT transfer and a plain send are native; the 0x swap is not', () => {
    for (const t of [fx.evmThorchainDeposit, fx.evmUsdtTransfer, { ...fx.evmNativeSend, data: '0x' }, fx.evmSwapNotNative]) evmCall(t)
    expect(rows().map((r) => [r.source, r.chain, r.protection_level, r.definition_source])).toEqual([
      ['vault-rpc', 'Ethereum', 'P4', 'native'], ['vault-rpc', 'Ethereum', 'P4', 'native'],
      ['vault-rpc', 'Ethereum', 'P4', 'native'], ['vault-rpc', 'Ethereum', 'P1', 'none'],
    ])
  })

  test('solanaSignTx: a transfer the device reviews is native; one it does not review is not', async () => {
    for (const t of [fx.solanaNativeSend, fx.solanaNotReviewed]) await recordVaultRpcSolanaTransaction(ctx(), {
      rawTx: t.rawTxBase64, source: 'none', definitionResolution: 'not-checked', solanaEndpoint: CLOSED,
    })
    expect(rows().map((r) => [r.source, r.protection_level, r.definition_source])).toEqual([
      ['vault-rpc', 'P4', 'native'], ['vault-rpc', 'P1', 'none'],
    ])
  })

  test('the helpers it uses agree', async () => {
    expect(evmShownNatively({ ...fx.evmUsdtTransfer }, FW)).toBe(true)
    expect(await solanaShownNatively(fx.solanaNativeSend.rawTxBase64, FW)).toBe(true)
  })

  test('a runtime blob beside a native call does not lower it', () => {
    const row = db.insertClearSignObservation(observeEvmCall({ chainId: 1, to: fx.evmUsdtTransfer.to, data: fx.evmUsdtTransfer.data, native: true }), { source: 'vault-rpc' })
    db.authenticateClearSignObservation(row.id, 'runtime')
    expect(rows()).toMatchObject([{ protection_level: 'P4', definition_source: 'native' }])
  })

  const signed = async () => ({ signature: '00' })
  test('every other signer writes one row, by chain (send dialog, PSBT, staking, messages)', async () => {
    const c = ctx()
    const cosmosTx = (doc: any) => ({ tx: { msg: doc.signDoc.msgs, fee: doc.signDoc.fee, memo: doc.signDoc.memo }, chain_id: doc.signDoc.chain_id })
    await observeVaultRpcSignature(c, 'btcSignTx', { coin: 'Bitcoin' }, signed)
    await observeVaultRpcSignature(c, 'btcPsbtSign', { coin: 'Bitcoin' }, signed)
    await observeVaultRpcSignature(c, 'cosmosSignTx', cosmosTx(fx.cosmosAminoSend), signed)
    await observeVaultRpcSignature(c, 'thorchainSignTx', cosmosTx(fx.thorchainAminoDeposit), signed)
    await observeVaultRpcSignature(c, 'xrpSignTx', {}, signed)
    await observeVaultRpcSignature(c, 'tronSignTx', { rawTx: fx.tronUsdtTransfer.rawDataHex }, signed)
    await observeVaultRpcSignature(c, 'tronSignTx', { rawTx: fx.tronTrc20OutsideTable.rawDataHex }, signed)
    await observeVaultRpcSignature(c, 'tonSignTx', { rawTx: fx.tonTransfer.rawTx }, signed)
    await observeVaultRpcSignature(c, 'hiveSignTx', {}, signed)
    await observeVaultRpcSignature(c, 'ethSignMessage', { message: fx.personalSignSiwe.messageHex }, signed)
    await observeVaultRpcSignature(c, 'ethSignMessage', { message: fx.ethSignSafeTxHash.messageHex }, signed)
    await observeVaultRpcSignature(c, 'solanaSignMessage', { message: Buffer.from(fx.solanaMessageText.messageUtf8).toString('base64') }, signed)
    await observeVaultRpcSignature(c, 'tronSignTypedHash', {}, signed)
    await observeVaultRpcSignature(c, 'tonSignMessage', { message: fx.hiveKeychainLogin.message }, signed)
    expect(rows().map((r) => [r.source, r.chain, r.request_kind, r.protection_level, r.outcome])).toEqual([
      ['vault-rpc', 'UTXO', 'transaction', 'P4', 'signed'],
      ['vault-rpc', 'UTXO', 'transaction', 'P4', 'signed'],
      ['vault-rpc', 'Cosmos', 'transaction', 'P4', 'signed'],
      ['vault-rpc', 'THORChain', 'transaction', 'P4', 'signed'],
      ['vault-rpc', 'XRP', 'transaction', 'P4', 'signed'],
      ['vault-rpc', 'Tron', 'transaction', 'P4', 'signed'],
      ['vault-rpc', 'Tron', 'transaction', 'P1', 'signed'],
      ['vault-rpc', 'TON', 'transaction', 'P1', 'signed'],
      ['vault-rpc', 'Hive', 'transaction', 'P4', 'signed'],
      ['vault-rpc', 'Ethereum', 'message', 'P4', 'signed'],
      ['vault-rpc', 'Ethereum', 'message', 'P1', 'signed'],
      ['vault-rpc', 'Solana', 'message', 'P4', 'signed'],
      ['vault-rpc', 'Tron', 'message', 'P1', 'signed'],
      ['vault-rpc', 'TON', 'message', 'P1', 'signed'],
    ])
    expect(JSON.parse(rows()[3].shape_json).msgTypes).toEqual(['thorchain/MsgDeposit'])
    expect(rows().map((r) => r.shape_json).join()).not.toMatch(/cosmos1|thor1|BSC\.USDT|example\.com/)
  })

  test('index.ts sends each of these signers through the wrapper', () => {
    const src = readFileSync(join(import.meta.dir, '../src/bun/index.ts'), 'utf8')
    for (const m of ['btcSignTx', 'btcPsbtSign', 'cosmosSignTx', 'thorchainSignTx', 'mayachainSignTx', 'osmosisSignTx', 'xrpSignTx',
      'tronSignTx', 'tonSignTx', 'hiveSignTx', 'ethSignMessage', 'solanaSignMessage', 'tronSignMessage', 'tronSignTypedHash',
      'tonSignMessage', 'solanaSignOffchainMessage']) expect(src, m).toContain(`observedRpcSign('${m}', `)
    expect(src).toContain('recordVaultRpcEvmCall(vaultRpcObservation, {')
    expect(src).toContain('recordVaultRpcSolanaTransaction(vaultRpcObservation, {')
  })

  test('a cancel on the device is rejected, anything else failed; a hidden wallet records nothing', async () => {
    await expect(observeVaultRpcSignature(ctx(), 'btcSignTx', {}, async () => { throw new ActionCancelled() })).rejects.toThrow()
    await expect(observeVaultRpcSignature(ctx(), 'btcSignTx', {}, async () => { throw new Error('Device disconnected') })).rejects.toThrow()
    await observeVaultRpcSignature(ctx({ passphrase: true }), 'btcSignTx', {}, signed)
    expect(rows().map((r) => r.outcome)).toEqual(['rejected', 'failed'])
  })
})

describe('REST: every signing route records a row', () => {
  test('every route without its own observer maps to a chain', () => {
    const own = new Set(['/eth/sign-transaction', '/eth/sign-typed-data', '/solana/sign-transaction', '/api/v2/swap/execute'])
    for (const route of SIGNING_ROUTES) {
      if (own.has(route)) continue
      expect(observeSigningInfo({ id: 'x', method: route } as any)?.chain, route).toBeDefined()
    }
  })

  async function restPost(path: string, body: unknown, opts: { passphrase?: boolean; wallet?: Record<string, unknown> } = {}) {
    const solanaKey = new Uint8Array(32).fill(7)
    const stop = async () => { throw new Error('test-stop') }
    const engine: any = Object.assign(new EventEmitter(), {
      isEmulator: false, isPassphraseWallet: opts.passphrase === true,
      getDeviceState: () => ({ state: 'ready', firmwareVersion: FW, deviceId: 'cs-observation-test' }),
      getCachedFeaturesSnapshot: () => undefined,
      wallet: {
        ethSignMessage: async () => ({ address: '0x0000000000000000000000000000000000000001', signature: '0x01' }),
        solanaGetAddress: async () => bs58.encode(solanaKey),
        solanaSignMessage: async () => ({ publicKey: solanaKey, signature: new Uint8Array(64) }),
        cosmosSignTx: stop, thorchainSignTx: stop, tronSignTx: stop, tonSignTx: stop, tonSignMessage: stop,
        ...opts.wallet,
      },
    })
    const auth: any = {
      requireAuth: () => ({ name: 'dapp', url: 'https://dapp.example' }), extractBearerToken: () => 'test', validate: () => true,
      getAccount: () => ({ addressNList: ETH_PATH }),
    }
    const server = startRestApi(engine, auth, 0, {
      onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
      onSigningRequest: async () => ({ approved: true }) as any, onSigningDismissed: () => {},
    } as any)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
      })
      return res.status
    } finally { server.stop(true) }
  }

  test('personal_sign of a SIWE login: native, signed', async () => {
    expect(await restPost('/eth/sign', { address: '0x0000000000000000000000000000000000000001', message: fx.personalSignSiwe.messageHex })).toBe(200)
    expect(rows()).toMatchObject([{ source: 'rest-api', chain: 'Ethereum', request_kind: 'message', protection_level: 'P4', definition_source: 'native', outcome: 'signed' }])
    expect(rows()[0].shape_json).not.toContain('example.com')
  }, 30_000)

  test('eth_sign of a Safe safeTxHash: 32 unreadable bytes, P1', async () => {
    await restPost('/eth/sign', { address: '0x0000000000000000000000000000000000000001', message: fx.ethSignSafeTxHash.messageHex })
    expect(rows()).toMatchObject([{ request_kind: 'message', protection_level: 'P1', definition_source: 'none' }])
    expect(JSON.parse(rows()[0].shape_json)).toEqual({ route: '/eth/sign', format: 'bytes', byteLength: 32 })
  }, 30_000)

  test('Solana sign-message with plain text: native', async () => {
    await restPost('/solana/sign-message', { message: Buffer.from(fx.solanaMessageText.messageUtf8).toString('base64') })
    expect(rows()).toMatchObject([{ chain: 'Solana', request_kind: 'message', protection_level: 'P4', outcome: 'signed' }])
  }, 30_000)

  test('Cosmos and THORChain amino: native, message types kept, values not', async () => {
    await restPost('/cosmos/sign-amino', { signerAddress: fx.cosmosAminoSend.signerAddress, signDoc: structuredClone(fx.cosmosAminoSend.signDoc) })
    await restPost('/thorchain/sign-amino-deposit', { signerAddress: fx.thorchainAminoDeposit.signerAddress, signDoc: structuredClone(fx.thorchainAminoDeposit.signDoc) })
    expect(rows().map((r) => [r.chain, r.request_kind, r.protection_level, JSON.parse(r.shape_json).msgTypes])).toEqual([
      ['Cosmos', 'transaction', 'P4', ['cosmos-sdk/MsgSend']],
      ['THORChain', 'transaction', 'P4', ['thorchain/MsgDeposit']],
    ])
    expect(rows().map((r) => r.shape_json).join()).not.toMatch(/cosmos1|thor1|45191972|BSC\.USDT/)
  }, 30_000)

  test('TON transaction and TON text message: the device blind-signs both, P1', async () => {
    await restPost('/ton/sign-transaction', { raw_tx: fx.tonTransfer.rawTx, to_address: 'EQ-untrusted', amount: '1' })
    await restPost('/ton/sign-message', { message: fx.hiveKeychainLogin.message })
    expect(rows().map((r) => [r.chain, r.request_kind, r.protection_level, r.definition_source])).toEqual([
      ['TON', 'transaction', 'P1', 'none'], ['TON', 'message', 'P1', 'none'],
    ])
  }, 30_000)

  test('Tron: TRX and USDT transfers are native; a TRC-20 outside the firmware table is P1', async () => {
    for (const t of [fx.tronTrxTransfer, fx.tronUsdtTransfer, fx.tronTrc20OutsideTable]) await restPost('/tron/sign-transaction', { raw_tx: t.rawDataHex })
    expect(rows().map((r) => [r.chain, r.protection_level, r.definition_source])).toEqual([
      ['Tron', 'P4', 'native'], ['Tron', 'P4', 'native'], ['Tron', 'P1', 'none'],
    ])
  }, 30_000)

  test('Hive Keychain login (printable challenge): shown as text, native', async () => {
    await restPost('/hive/sign-message', { message: fx.hiveKeychainLogin.message })
    expect(rows()).toMatchObject([{ chain: 'Hive', request_kind: 'message', protection_level: 'P4', definition_source: 'native' }])
    expect(JSON.parse(rows()[0].shape_json)).toEqual({ route: '/hive/sign-message', format: 'text' })
  }, 30_000)

  test('a cancel on the device is rejected, not failed', async () => {
    await restPost('/cosmos/sign-amino', { signerAddress: fx.cosmosAminoSend.signerAddress, signDoc: structuredClone(fx.cosmosAminoSend.signDoc) },
      { wallet: { cosmosSignTx: async () => { throw new ActionCancelled() } } })
    expect(rows()).toMatchObject([{ chain: 'Cosmos', outcome: 'rejected' }])
  }, 30_000)

  test('BTC multisig while the feature is off: policy-blocked', async () => {
    db.setSetting('btc_multisig_enabled', '0')
    expect(await restPost('/utxo/sign-transaction', {
      coin: 'Bitcoin', inputs: [{ scriptType: 'p2wsh', amount: '1000', multisig: { m: 2, pubkeys: [] } }], outputs: [{ address: 'bc1qtest', amount: '900' }],
    })).toBe(403)
    expect(rows()).toMatchObject([{ chain: 'UTXO', outcome: 'policy-blocked' }])
  }, 30_000)

  test('a hidden (passphrase) wallet records nothing', async () => {
    await restPost('/eth/sign', { address: '0x0000000000000000000000000000000000000001', message: fx.personalSignSiwe.messageHex }, { passphrase: true })
    expect(rows()).toEqual([])
  }, 30_000)
})

describe('WalletConnect: messages and Cosmos sign docs record a row', () => {
  function wc() {
    const drafts: any[] = []
    const finalized: string[] = []
    const solanaKey = bs58.encode(new Uint8Array(32).fill(7))
    const manager: any = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: '0x0000000000000000000000000000000000000001', addressIndex: 0 }),
      ethSignMessage: async () => ({ signature: '0x01' }),
      getCosmosAccountInfo: async () => ({ address: fx.cosmosAminoSend.signerAddress, pubkeyBase64: '', addressNList: [] }),
      cosmosSignAmino: async () => ({ signatureBase64: 'AA==' }),
      getSolanaAccountInfo: async () => ({ address: solanaKey, addressNList: [] }),
      solanaSignMessageRaw: async () => ({ signatureBase64: Buffer.alloc(64).toString('base64') }),
      recordClearSignObservation: (draft: any) => { drafts.push(draft); return `obs-${drafts.length}` },
      finalizeClearSignObservation: (_id: string, outcome: string) => { finalized.push(outcome) },
      requestSigningApproval: async () => true,
      dismissSigning: () => {},
      log: () => {},
    } as any)
    return { manager, drafts, finalized }
  }

  test('personal_sign (SIWE) is native; eth_sign of a safeTxHash is P1', async () => {
    const { manager, drafts, finalized } = wc()
    await manager.handleRequest('personal_sign', [fx.personalSignSiwe.messageHex, '0x0000000000000000000000000000000000000001'], 'eip155:1', 'dapp')
    await manager.handleRequest('eth_sign', ['0x0000000000000000000000000000000000000001', fx.ethSignSafeTxHash.messageHex], 'eip155:1', 'dapp')
    expect(drafts.map((d) => [d.chain, d.requestKind, d.protectionLevel])).toEqual([
      ['Ethereum', 'message', 'P4'], ['Ethereum', 'message', 'P1'],
    ])
    expect(finalized).toEqual(['signed', 'signed'])
  })

  test('a cancel on the device is rejected, not failed', async () => {
    const { manager, finalized } = wc()
    manager.callbacks.ethSignMessage = async () => { throw new ActionCancelled() }
    await expect(manager.handleRequest('personal_sign', [fx.personalSignSiwe.messageHex, '0x0000000000000000000000000000000000000001'], 'eip155:1', 'dapp')).rejects.toThrow()
    expect(finalized).toEqual(['rejected'])
  })

  test('cosmos_signAmino and solana_signMessage', async () => {
    const { manager, drafts } = wc()
    await manager.handleRequest('cosmos_signAmino', { signerAddress: fx.cosmosAminoSend.signerAddress, signDoc: fx.cosmosAminoSend.signDoc }, 'cosmos:cosmoshub-4', 'dapp')
    await manager.handleRequest('solana_signMessage', { message: bs58.encode(Buffer.from(fx.solanaMessageText.messageUtf8)) }, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'dapp')
    expect(drafts.map((d) => [d.chain, d.requestKind, d.protectionLevel])).toEqual([
      ['Cosmos', 'transaction', 'P4'], ['Solana', 'message', 'P4'],
    ])
  })
})

test('coverage summary counts the new chains and never queues them for audit', () => {
  db.insertClearSignObservation(observeSigningInfo({ id: 'x', method: '/thorchain/sign-amino-deposit' } as any)!, { source: 'rest-api' })
  // A P1 message would otherwise be queued for a contract audit it cannot have.
  const hash = observeSigningInfo({ id: 'y', method: '/eth/sign', ethMessageDecoded: { address: '', messageRaw: fx.ethSignSafeTxHash.messageHex, isUtf8Text: false } } as any)!
  expect(hash.protectionLevel).toBe('P1')
  db.insertClearSignObservation(hash, { source: 'walletconnect' })
  const summary = db.getClearSignCoverageSummary()
  expect(summary.byChain.THORChain).toMatchObject({ totalRequests: 1, authenticatedRequests: 1 })
  expect(summary.componentCoverage.authenticatedAppearances).toBe(1)
  expect(summary.topUnknown.map((u) => u.shapeKey)).toEqual([hash.shapeKey])
  expect(db.getDb()!.query(`SELECT COUNT(*) AS n FROM clearsign_audit_jobs WHERE shape_key = ?`).get(hash.shapeKey)).toEqual({ n: 0 })
})
