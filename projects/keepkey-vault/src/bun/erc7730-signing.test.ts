/**
 * ERC-7730 at the EVM sign sites: the preview, the AdvancedMode gate, the
 * verdict and the risk bar agree, and a refused definition falls back to the
 * normal path. The ClearSign service is stubbed (fetch); the definition is a
 * real registry program signed under a TEST root.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SigningRequestInfo } from '../shared/types'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { buildClearSignReport } from '../shared/clearsign-report'
import { evmSigningVerdict, prepareEvmTxSigningInfo, withoutErc7730Description } from './evm-presign-report'
import { attachErc7730Definition } from './evm-signing-preview'
import { evmCallRequiresAdvancedMode } from './evm-signing-policy'
import { forgetRefusedErc7730Definitions } from './erc7730-resolver'
import fixtures from './erc7730-resolver.fixtures.json'
import { ERC7730_FIXTURE_ROOT_PUBLIC_KEY, trustTestRoot } from '../../__tests__/support/clearsign-test-root'
// The replay fixtures are signed under their TEST root: trusted for this file.
let restoreRoot = () => {}
beforeAll(() => { restoreRoot = trustTestRoot(ERC7730_FIXTURE_ROOT_PUBLIC_KEY) })
afterAll(() => restoreRoot())

const { tx, definition } = fixtures.plain
const FROM = '0x1111111111111111111111111111111111111111'
const FW = '7.16.0'
const CAPS = [1, 4]
const UNAVAILABLE = { status: 'unavailable', transactionFingerprint: 'f', assetChanges: [], authorityChanges: [], warnings: [], unknowns: [] } as any

let lookups: string[] = []
const originalFetch = globalThis.fetch
beforeEach(() => {
  lookups = []
  forgetRefusedErc7730Definitions()
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('/v1/erc7730/definition')) { lookups.push(u); return Response.json(definition) }
    // Every other ClearSign lookup: not in the signed catalog.
    return Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

function info(data = tx.data): SigningRequestInfo {
  return {
    id: 'card', method: '/eth/sign-transaction', appName: 'dapp', chain: 'eth',
    from: FROM, to: tx.to, value: tx.value, chainId: tx.chainId, data, firmwareVersion: FW, advancedModeEnabled: false,
  }
}

async function prepared(capabilities?: number[], data = tx.data, preview: any = {}) {
  const i = info(data)
  await prepareEvmTxSigningInfo(i, { to: tx.to, data, value: tx.value, from: FROM, ...preview }, FW, capabilities)
  return i
}

describe('a ClearSign service definition keeps preview, gate and verdict in step', () => {
  test('attachable: device-shown, no AdvancedMode, a green verdict', async () => {
    const i = await prepared(CAPS)
    expect(i.erc7730?.primaryDefinitionId).toBe(`0x${definition.definitionId}`)
    expect(i.needsBlindSigning).toBe(false)
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, i.erc7730, FW, tx.value, CAPS)).toBe(false)
    const verdict = evmSigningVerdict(i, {}, UNAVAILABLE, false)
    expect(verdict.requestedLevel).toBe('P4')
    expect(verdict.descriptor).toMatchObject({ source: 'erc7730', format: 'ERC7730', authenticated: true })
    expect(assessSigningRisk(i)?.tier).toBe('green')
  })

  test('without the capability: none fetched, blind, not green', async () => {
    const i = await prepared([1])
    expect(lookups).toEqual([])
    expect(i.erc7730).toBeUndefined()
    expect(i.needsBlindSigning).toBe(true)
    expect(evmSigningVerdict(i, {}, UNAVAILABLE, false).requestedLevel).not.toBe('P4')
    expect(assessSigningRisk(i)?.tier).not.toBe('green')
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, undefined, FW, tx.value, [1])).toBe(true)
  })

  test('arguments that are not whole words or an approval: none fetched, blind', async () => {
    for (const data of [`${tx.data}${'00'.repeat(5)}`, `0x095ea7b3${FROM.slice(2).padStart(64, '0')}${'ff'.repeat(32)}`]) {
      const i = await prepared(CAPS, data)
      expect(i.erc7730).toBeUndefined()
      expect(lookups).toEqual([])
    }
  })

  test('kind-1 wins: a caller blob or an attached certified blob means no definition', async () => {
    const caller = await prepared(CAPS, tx.data, { txMetadata: { signedPayload: '0x0102', keyId: 1 } })
    expect(caller.erc7730).toBeUndefined()
    const blob = info()
    blob.needsBlindSigning = true
    blob.calldataDecoded = { dappName: 'x', contractName: 'x', method: 'm', selector: '0x5bcb2fc6', fields: [], source: 'none', signedInsightBlob: 'AQI=', insightKeyId: 0x80 }
    expect(await attachErc7730Definition(blob, tx.to, tx.data, FW, CAPS)).toBe(false)
    expect(lookups).toEqual([])
    // And beside caller metadata the verdict is never ERC-7730.
    const both = await prepared(CAPS)
    expect(evmSigningVerdict(both, { txMetadata: { signedPayload: '0x0102', keyId: 1 } }, UNAVAILABLE, false).descriptor.source).not.toBe('erc7730')
  })
})

describe('after the device refuses the definition', () => {
  test('the card reads as the blind call it now is', async () => {
    const i = await prepared(CAPS)
    i.clearSignReport = buildClearSignReport({ ...evmSigningVerdict(i, {}, UNAVAILABLE, false), simulation: UNAVAILABLE })
    expect(i.clearSignReport.protectionLevel).toBe('P4')
    const plain = withoutErc7730Description(i)
    expect(plain.id).not.toBe(i.id)
    expect(plain.erc7730).toBeUndefined()
    expect(plain.needsBlindSigning).toBe(true)
    expect(plain.clearSignReport?.protectionLevel).not.toBe('P4')
    expect(plain.clearSignReport?.descriptor.source).toBe('none')
    expect(plain.clearSignReport?.limitations.map((l) => l.code)).toContain('ERC7730_DEFINITION_REFUSED')
    expect(assessSigningRisk(plain)?.tier).not.toBe('green')
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, plain.erc7730, FW, tx.value, CAPS)).toBe(true)
  })
})

describe('WalletConnect eth_sendTransaction', () => {
  const failure = (message: string) => ({ message_type: 'FAILURE', message_enum: 3, message: { code: 9, message } })

  async function wcSign(opts: { advancedMode: boolean; caps?: number[]; refuse?: string; declineSecondCard?: boolean }) {
    const { WalletConnectManager } = await import('./walletconnect')
    const cap = { sent: [] as any[], cards: [] as any[], dismissed: [] as string[], refused: [] as string[], finalized: [] as string[] }
    const manager: any = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: FROM, addressIndex: 0 }),
      ensureEvmAddressInfo: async () => null,
      ethSignTx: async (msg: any) => {
        cap.sent.push(structuredClone(msg))
        if (msg.erc7730 && opts.refuse) throw failure(opts.refuse)
        throw new Error('test-stop')
      },
      getAdvancedModeEnabled: () => opts.advancedMode,
      loadClearsignSigner: async () => {},
      getFirmwareVersion: () => FW,
      getDeviceCapabilities: () => opts.caps ?? CAPS,
      getEvmSimulationEndpoint: () => 'http://127.0.0.1:9/',
      getSolanaRpcEndpoint: () => 'http://127.0.0.1:9/',
      recordClearSignObservation: () => 'obs',
      authenticateClearSignObservation: () => {},
      finalizeClearSignObservation: (_id: string, outcome: string) => { cap.finalized.push(outcome) },
      refuseClearSignObservationDefinition: (id: string) => { cap.refused.push(id) },
      requestSigningApproval: async (card: any) => {
        cap.cards.push(structuredClone(card))
        return !(opts.declineSecondCard && cap.cards.length === 2)
      },
      dismissSigning: (id: string) => { cap.dismissed.push(id) },
      log: () => {},
    } as any)
    const run = manager.signTransaction({
      from: FROM, to: tx.to, data: tx.data, value: tx.value,
      chainId: `0x${tx.chainId.toString(16)}`, nonce: '0x0', gas: '0x30000', gasPrice: '0x1',
    }, [0x8000002c, 0x8000003c, 0x80000000, 0, 0], 'test-dapp', tx.chainId, false)
    return { cap, run }
  }

  test('sends the definition the card was built on', async () => {
    const { cap, run } = await wcSign({ advancedMode: false })
    await expect(run).rejects.toThrow('test-stop')
    expect(cap.cards.length).toBe(1)
    expect(cap.cards[0].needsBlindSigning).toBe(false)
    expect(cap.cards[0].erc7730.primaryDefinitionId).toBe(`0x${definition.definitionId}`)
    expect(cap.sent.length).toBe(1)
    expect(cap.sent[0].erc7730).toEqual(cap.cards[0].erc7730)
    expect(cap.sent[0].txMetadata).toBeUndefined()
  })

  test('no definition without the capability', async () => {
    const { cap, run } = await wcSign({ advancedMode: false, caps: [1] })
    await expect(run).rejects.toThrow('test-stop')
    expect(cap.cards[0].needsBlindSigning).toBe(true)
    expect(cap.sent[0].erc7730).toBeUndefined()
  })

  for (const refusal of ['Value too long to clear-sign', 'Inner call cannot be clear-signed', 'Invalid ERC-7730 execution program', 'AdvancedMode required for ERC-7730']) {
    test(`"${refusal}" with AdvancedMode off: the blind-sign card, then the call without the definition`, async () => {
      const { cap, run } = await wcSign({ advancedMode: false, refuse: refusal })
      await expect(run).rejects.toThrow('test-stop')
      expect(cap.sent.length).toBe(2)
      expect(cap.sent[0].erc7730).toBeDefined()
      expect(cap.sent[1].erc7730).toBeUndefined()
      expect(cap.cards.length).toBe(2)
      expect(cap.cards[1].needsBlindSigning).toBe(true)
      expect(cap.cards[1].erc7730).toBeUndefined()
      // Both cards are dismissed.
      expect(cap.dismissed).toEqual([cap.cards[0].id, cap.cards[1].id])
    })
  }

  test('with AdvancedMode on too: the blind card again before the call without the definition', async () => {
    const { cap, run } = await wcSign({ advancedMode: true, refuse: 'Inner call cannot be clear-signed' })
    await expect(run).rejects.toThrow('test-stop')
    expect(cap.sent.map((m) => Boolean(m.erc7730))).toEqual([true, false])
    expect(cap.cards.length).toBe(2)
    expect(cap.cards[1].needsBlindSigning).toBe(true)
    expect(cap.cards[1].erc7730).toBeUndefined()
    expect(cap.cards[1].clearSignReport?.descriptor.source).not.toBe('erc7730')
    // The coverage record no longer names the refused definition.
    expect(cap.refused).toEqual(['obs'])
  })

  test('declining the blind-sign card signs nothing more and is recorded as rejected', async () => {
    const { cap, run } = await wcSign({ advancedMode: true, refuse: 'Value too long to clear-sign', declineSecondCard: true })
    await expect(run).rejects.toThrow('User rejected signing')
    expect(cap.sent.length).toBe(1)
    expect(cap.finalized[0]).toBe('rejected')
  })
})

describe('in-app swap', () => {
  test('a refused definition is never signed blind under the swap card', async () => {
    const { signWithErc7730Fallback } = await import('./erc7730-resolver')
    const { ERC7730_SWAP_REREVIEW, stopSwapAfterErc7730Refusal } = await import('./swap')
    const msg = { to: tx.to, data: tx.data, chainId: tx.chainId, value: tx.value, erc7730: (await prepared(CAPS)).erc7730 }
    for (const advancedMode of [true, false]) {
      forgetRefusedErc7730Definitions()
      const sent: boolean[] = []
      const sign = async (m: any) => { sent.push(Boolean(m.erc7730)); if (m.erc7730) throw new Error('Value too long to clear-sign'); return 'signed' }
      const assertEvmSignable = (plain: any) => {
        if (evmCallRequiresAdvancedMode(plain.to, plain.data, plain.chainId, advancedMode, plain.txMetadata, plain.erc7730, FW, plain.value, CAPS)) {
          throw new Error('This ETH swap has to be blind-signed. Turn on AdvancedMode to continue.')
        }
      }
      const run = signWithErc7730Fallback(msg, sign, stopSwapAfterErc7730Refusal(assertEvmSignable))
      // Off: the AdvancedMode opt-in panel. On: back to review, rebuilt without the definition.
      await expect(run).rejects.toThrow(advancedMode ? ERC7730_SWAP_REREVIEW : /AdvancedMode/)
      expect(sent).toEqual([true])
    }
    // SwapDialog routes /AdvancedMode/i to the opt-in panel; the re-review message must not match.
    expect(/AdvancedMode/i.test(ERC7730_SWAP_REREVIEW)).toBe(false)
    // The rebuilt preview does not attach the refused definition again.
    expect((await prepared(CAPS)).erc7730).toBeUndefined()
  })

  test('the swap card looks up a definition only where the signer attaches one', async () => {
    const { buildEvmReportForTx } = await import('./evm-presign-report')
    const report = async (capabilities?: number[]) => (await buildEvmReportForTx({
      tx: { chainId: tx.chainId, from: FROM, to: tx.to, data: tx.data, value: tx.value },
      firmwareVersion: FW, capabilities, endpoint: 'http://127.0.0.1:9/', signerVerdict: true,
      measure: async () => { throw new Error('offline') },
    })).report
    // A router call the swap signs without a definition: no lookup, the blind verdict.
    const without = await report(undefined)
    expect(lookups).toEqual([])
    expect(without.protectionLevel).not.toBe('P4')
    expect(without.descriptor.source).not.toBe('erc7730')
    // The swap card passes the device capabilities only for a transaction that carries one.
    const index = await Bun.file(new URL('./index.ts', import.meta.url)).text()
    expect(index).toContain('capabilities: tx.erc7730 ? engine.getDeviceState().capabilities : undefined,')
  })
})
