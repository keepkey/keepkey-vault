/**
 * The approval card says what the connected firmware will actually do.
 * Every request is a real one the 2026-10-30 emulator legs ran on 7.14.2 and
 * 7.16.0 (multisig-design/emulator-legs-20261030); each test names the leg.
 *
 *  - WalletConnect eth_signTypedData_v4 predicts AdvancedMode the way REST does
 *    (safe G10: 7.14.2 refused 'Enable AdvancedMode to blind-sign typed hashes').
 *  - A TRON transfer is green only when this firmware parses it (T0/T1 on 7.14.2,
 *    T2 on 7.16.0 blind-signed under a green card).
 *  - A request 7.14.2 refuses outright says so and never asks for AdvancedMode
 *    (Solana v0 lookup tables 'Malformed Solana transaction'; THOR/Maya memos
 *    cancelled after 4 screens).
 *  - Device wording: 7.14 "Using Asgard vault", hash-only typed data, one
 *    Permit2 token, and the certified schema 7.16 shows for a native approve.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SigningRequestInfo } from '../src/shared/types'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import { applyEvmTxPreview, applyTypedDataSigningGate, recognizedTypedDataSpender } from '../src/bun/evm-signing-preview'
import { applyTronSigningPreview } from '../src/bun/tron-preview'
import { applySolanaSigningGates } from '../src/bun/solana-consent'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { evmSigningVerdict, prepareEvmTxSigningInfo } from '../src/bun/evm-presign-report'
import safeUsdc from './fixtures/safe/base-usdc-transfer.json'
import real from './fixtures/clearsign-observation/real-requests.json'
import deposits from './fixtures/thorchain/router-deposits.json'
import cowPermit from './fixtures/spenders/usdc-permit-cow-vaultrelayer.json'
import oneInchPermit2 from './fixtures/spenders/permit2-1inch-v6-unlimited.json'
import usdcSchema from './fixtures/approve-spender-name/schema-usdc-approve-chain1.json'
import swapsProApprove from '../../../docs/clearsign-case-studies/swapspro-20261029/requests/approve-cow-vaultrelayer.json'
import solanaVerdicts from './fixtures/solana/advanced-mode-firmware-verdicts.json'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const offline = () => { globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch }
const text = (r: ReturnType<typeof assessSigningRisk>) => r!.reasons.map((x) => `${x.level}: ${x.text}`).join('\n')

// ── WalletConnect eth_signTypedData_v4 ───────────────────────────────

describe('WalletConnect typed data predicts AdvancedMode like REST (safe leg base-usdc-transfer)', () => {
  async function wcCard(fw: string): Promise<SigningRequestInfo> {
    offline()
    const { WalletConnectManager } = await import('../src/bun/walletconnect')
    let card: SigningRequestInfo | undefined
    const manager: any = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: safeUsdc.signer, addressIndex: 0 }),
      getFirmwareVersion: () => fw,
      getDeviceCapabilities: () => [],
      recordClearSignObservation: () => undefined,
      finalizeClearSignObservation: () => {},
      requestSigningApproval: async (info: SigningRequestInfo) => { card = structuredClone(info); return false },
      dismissSigning: () => {},
      log: () => {},
    } as any)
    await expect(manager.signTypedData(safeUsdc.typedData, [0x8000002c, 0x8000003c, 0x80000000, 0, 0], 'Safe{Wallet}', 8453))
      .rejects.toThrow('User rejected signing')
    return card!
  }
  const restCard = (fw: string): SigningRequestInfo => {
    const info = { id: 'r', method: '/eth/sign-typed-data', appName: 'Safe{Wallet}', typedDataDecoded: decodeEIP712(safeUsdc.typedData, safeUsdc.signer) } as SigningRequestInfo
    applyTypedDataSigningGate(info, safeUsdc.typedData, fw)
    return info
  }

  test('7.14.2 hash-signs a SafeTx: both paths require AdvancedMode', async () => {
    const wc = await wcCard('7.14.2')
    expect(wc.requiresAdvancedMode).toBe(true)
    expect(wc.needsBlindSigning).toBe(true)
    expect(restCard('7.14.2')).toMatchObject({ requiresAdvancedMode: true, needsBlindSigning: true })
  })

  test('7.16.0 streams the document: neither path requires AdvancedMode', async () => {
    const wc = await wcCard('7.16.0')
    expect(wc.requiresAdvancedMode).toBe(false)
    expect(wc.needsBlindSigning).toBe(false)
    expect(restCard('7.16.0')).toMatchObject({ requiresAdvancedMode: false, needsBlindSigning: false })
  })

  test('unknown firmware stays gated; x402 and a 7.16 Permit2 PermitSingle are native', () => {
    expect(restCard('').requiresAdvancedMode).toBe(true)
    const permit2 = { id: 'p', method: '/eth/sign-typed-data', appName: 'a', typedDataDecoded: decodeEIP712(oneInchPermit2.typedData) } as SigningRequestInfo
    applyTypedDataSigningGate(permit2, oneInchPermit2.typedData, '7.16.0')
    expect(permit2.requiresAdvancedMode).toBe(false)
  })
})

// ── TRON ─────────────────────────────────────────────────────────────

describe('a TRON transfer is green only where the firmware parses it (nonevm T0/T1/T2)', () => {
  const card = (hex: string, fw: string) => {
    const info = { id: 't', method: '/tron/sign-transaction', appName: 'leg', firmwareVersion: fw, rawRequestBody: { raw_tx: hex } } as SigningRequestInfo
    applyTronSigningPreview(info, hex, fw)
    return { info, risk: assessSigningRisk(info)! }
  }

  test('7.14.2 blind-signs TRX and USDT transfers: AdvancedMode, not green', () => {
    for (const hex of [real.tronTrxTransfer.rawDataHex, real.tronUsdtTransfer.rawDataHex]) {
      const { info, risk } = card(hex, '7.14.2')
      expect(info.tronDecoded).toBeDefined()
      expect(info.requiresAdvancedMode).toBe(true)
      expect(info.needsBlindSigning).toBe(true)
      expect(risk.tier).not.toBe('green')
      expect(risk.headline).not.toBe('Shown on your KeepKey')
      expect(text(risk)).toContain('KeepKey firmware 7.14.2 cannot show this transfer on the device: it signs it blind')
      expect(text(risk)).not.toContain('Your KeepKey shows this transfer')
    }
  })

  test('7.16.0: TRX and USDT are shown; a TRC-20 outside the firmware table is not', () => {
    for (const hex of [real.tronTrxTransfer.rawDataHex, real.tronUsdtTransfer.rawDataHex]) {
      const { info, risk } = card(hex, '7.16.0')
      expect(info.requiresAdvancedMode).toBe(false)
      expect(risk.tier).toBe('green')
      expect(text(risk)).toContain('Your KeepKey shows this transfer')
    }
    const { info, risk } = card(real.tronTrc20OutsideTable.rawDataHex, '7.16.0')
    expect(info.tronDecoded).toBeDefined()
    expect(info.requiresAdvancedMode).toBe(true)
    expect(risk.tier).not.toBe('green')
  })

  // T2 on 7.16.0 with AdvancedMode on: "TRON Blind Sign | Sign 211-byte TRON
  // transaction?", then "Token contract TEkx…", then "Send 1169566735 base
  // units to THLy…?". 7.14.2 shows neither amount nor recipient.
  test('T2 outside the table: 7.16 shows contract, base units and recipient after the warning; 7.14 shows neither', () => {
    const now = text(card(real.tronTrc20OutsideTable.rawDataHex, '7.16.0').risk)
    expect(now).toContain('KeepKey firmware 7.16.0 does not know this token: it warns "TRON Blind Sign" and needs Advanced Mode, then shows the token contract, the amount in base units and the recipient. Check those on your KeepKey.')
    expect(now).not.toContain('without the amount or recipient')
    const old = text(card(real.tronTrc20OutsideTable.rawDataHex, '7.14.2').risk)
    expect(old).toContain('KeepKey firmware 7.14.2 cannot show this transfer on the device: it signs it blind, without the amount or recipient')
    expect(old).not.toContain('TRON Blind Sign')
  })

  // Every 7.15 build parses TRON (tron_parseRawTx): TRX and table tokens are
  // shown. A TRC-20 outside the table differs by build (release/7.15 shows it,
  // 7.15-b6 gates it), so 7.15 does not force AdvancedMode for it either.
  test('7.15.0: TRX, USDT and an outside-table TRC-20 never require AdvancedMode', () => {
    for (const hex of [real.tronTrxTransfer.rawDataHex, real.tronUsdtTransfer.rawDataHex, real.tronTrc20OutsideTable.rawDataHex]) {
      const { info, risk } = card(hex, '7.15.0')
      expect(info.requiresAdvancedMode).toBe(false)
      expect(info.needsBlindSigning).toBe(false)
      expect(text(risk)).toContain('Your KeepKey shows this transfer')
    }
  })
})

// ── Requests 7.14.2 refuses outright ─────────────────────────────────

describe('a request the firmware refuses outright never asks for AdvancedMode', () => {
  test('Solana v0 with lookup tables (S3 jupiter-route-v2): 7.14.2 cannot sign it, 7.16 only as raw data', async () => {
    const fx = await Bun.file(`${import.meta.dir}/fixtures/clearsign-chains/jupiter-route-v2.json`).json()
    const decoded = await buildSolanaDecodedInfo(fx.rawTx, async (keys: string[]) => keys.map((k) => {
      const a = fx.accounts[k]
      return a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data, 'base64')) } : null
    }))
    const at = (fw: string) => {
      const info = { id: 's', method: '/solana/sign-transaction', appName: 'leg', firmwareVersion: fw, from: fx.accountKeys[0], solanaDecoded: decoded } as SigningRequestInfo
      applySolanaSigningGates(info, fx.rawTx, fw)
      return { info, risk: assessSigningRisk(info)! }
    }
    const old = at('7.14.2')
    expect(old.info.firmwareCannotSign).toBe(true)
    expect(old.info.requiresAdvancedMode).toBe(false)
    // 7.16 reviews it only as raw data: an update alone does not get it shown.
    expect(old.info.firmwareUpdateClearSigns).toBe(false)
    expect(text(old.risk)).toContain('KeepKey firmware 7.14.2 cannot sign this: your KeepKey will refuse it. Newer firmware does not show it on the device either.')
    expect(text(old.risk)).not.toContain('Updating')
    expect(old.risk.headline).toBe('KeepKey firmware 7.14.2 cannot sign this')
    expect(text(old.risk)).toContain('through Jupiter')
    expect(text(old.risk)).not.toContain('Advanced Mode')
    expect(text(old.risk)).not.toContain('raw data')
    // 7.16 reviews it (opaque, behind AdvancedMode): not a firmware gap.
    expect(at('7.16.0').info.firmwareCannotSign).toBeUndefined()
  })

  // advanced-mode-firmware-verdicts.json: each case run through the real
  // firmware builds' Solana review (7.14.2 e519dc13c, 7.16.0 4f94a63b6).
  const solanaCase = async (name: string, fw: string) => {
    const c = solanaVerdicts.cases.find((x: any) => x.name === name)!
    const decoded = await buildSolanaDecodedInfo(c.rawTx, async (keys: string[]) => keys.map(() => null))
    const info = { id: 's', method: '/solana/sign-transaction', appName: 'leg', firmwareVersion: fw, solanaDecoded: decoded } as SigningRequestInfo
    applySolanaSigningGates(info, c.rawTx, fw)
    return { info, risk: assessSigningRisk(info)!, verdicts: c.verdicts as Record<string, string> }
  }

  test('v0 with nine SOL transfers: 7.14.2 refuses it, so the card is never green; 7.16 shows it', async () => {
    const old = await solanaCase('v0, nine SOL transfers', '7.14.2')
    expect(old.verdicts.e519dc13ced6adbd77cc5ceb6207f3cc04e57492).toBe('MALFORMED')
    expect(old.verdicts['4f94a63b6632be48379c95465b3a9f4ae6e561bb']).toBe('VERIFIED')
    expect(old.info.firmwareCannotSign).toBe(true)
    expect(old.info.firmwareUpdateClearSigns).toBe(true)
    expect(old.risk.tier).not.toBe('green')
    expect(old.risk.headline).toBe('KeepKey firmware 7.14.2 cannot sign this. Update your firmware')
    expect(text(old.risk)).toContain('KeepKey firmware 7.14.2 cannot sign this: your KeepKey will refuse it. Updating your KeepKey firmware fixes this.')
    expect(text(old.risk)).not.toContain('shows every step')
    const now = await solanaCase('v0, nine SOL transfers', '7.16.0')
    expect(now.info.firmwareCannotSign).toBeUndefined()
    expect(now.risk.tier).toBe('green')
    expect(now.risk.headline).toBe('Shown on your KeepKey')
  })

  test('v0 transfer to a lookup-table account: 7.14.2 refuses it, 7.16 reviews it as raw data, so no update promise', async () => {
    const old = await solanaCase('v0 transfer to a lookup-table account', '7.14.2')
    expect(old.verdicts['4f94a63b6632be48379c95465b3a9f4ae6e561bb']).toBe('OPAQUE')
    expect(old.info.firmwareCannotSign).toBe(true)
    expect(old.info.firmwareUpdateClearSigns).toBe(false)
    expect(old.risk.tier).not.toBe('green')
    expect(old.risk.headline).toBe('KeepKey firmware 7.14.2 cannot sign this')
    expect(text(old.risk)).not.toContain('Updating')
  })

  test('the card keeps Approve off for a request the firmware refuses', () => {
    const card = readFileSync(new URL('../src/mainview/components/device/SigningApproval.tsx', import.meta.url), 'utf8')
    expect(card.split('\n').find((l) => l.includes('const approveDisabled ='))).toContain('firmwareCannotSign')
  })

  const deposit = (name: string) => deposits.deposits.find((d: any) => d.name.startsWith(name))!
  const evmCard = async (d: any, fw: string) => {
    offline()
    const info = { id: 'e', method: '/eth/sign-transaction', appName: 'leg', chain: 'eth', from: d.from, to: d.to, value: d.value, data: d.data, chainId: Number(d.chainId), firmwareVersion: fw } as SigningRequestInfo
    await applyEvmTxPreview(info, d.to, d.data, Number(d.chainId), fw)
    return { info, risk: assessSigningRisk(info)! }
  }

  for (const name of ['Maya: ETH -> MAYA.CACAO', 'BSC BNB -> ETH.ETH']) {
    test(`THOR/Maya deposit 7.14.2 cancels (${name}): no AdvancedMode, an update fixes it`, async () => {
      const old = await evmCard(deposit(name), '7.14.2')
      expect(old.info.firmwareCannotSign).toBe(true)
      expect(old.info.firmwareUpdateClearSigns).toBe(true)
      expect(text(old.risk)).toContain('KeepKey firmware 7.14.2 cannot sign this: your KeepKey will refuse it. Updating your KeepKey firmware fixes this.')
      expect(text(old.risk)).not.toContain('Advanced Mode')
      expect(old.risk.headline).toBe('KeepKey firmware 7.14.2 cannot sign this. Update your firmware')
      const now = await evmCard(deposit(name), '7.16.0')
      expect(now.info.firmwareCannotSign).toBeUndefined()
      expect(now.info.needsBlindSigning).toBe(false)
    })
  }

  // The same Maya deposit from a stale quote to the legacy Maya router
  // (0xd89dce57…): 7.14.2 cancels it like the leg, but 7.16 pins only Maya v4
  // and Arbitrum, so an update would not get it clear-signed.
  test('Maya deposit to the legacy router: 7.14.2 refuses it, no update promise', async () => {
    const legacy = { ...deposit('Maya: ETH -> MAYA.CACAO'), to: '0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2' }
    const old = await evmCard(legacy, '7.14.2')
    expect(old.info.firmwareCannotSign).toBe(true)
    expect(old.info.firmwareUpdateClearSigns).toBe(false)
    expect(text(old.risk)).not.toContain('Updating')
    expect(text(old.risk)).not.toContain('Advanced Mode')
    expect(old.risk.headline).toBe('KeepKey firmware 7.14.2 cannot sign this')
    expect((await evmCard(legacy, '7.16.0')).info.deviceClearSigns).toBe(false)
  })

  test('a deposit 7.14.2 signs is not marked (ETH -> ETH.USDT)', async () => {
    const { info } = await evmCard(deposit('ETH -> ETH.USDT'), '7.14.2')
    expect(info.firmwareCannotSign).toBeUndefined()
    expect(info.deviceClearSigns).toBe(true)
  })
})

// ── Device wording ───────────────────────────────────────────────────

describe('card text matches the device screens', () => {
  test('THOR vault: 7.14 shows "Using Asgard vault", 7.16 labels it UNVERIFIED, 7.15 names no screen', async () => {
    const d = deposits.deposits.find((x: any) => x.name.startsWith('ETH -> ETH.USDT'))!
    const at = async (fw: string) => {
      offline()
      const info = { id: 'e', method: '/eth/sign-transaction', appName: 'leg', chain: 'eth', from: d.from, to: d.to, value: d.value, data: d.data, chainId: 1, firmwareVersion: fw } as SigningRequestInfo
      await applyEvmTxPreview(info, d.to, d.data, 1, fw)
      info.thorVault = { status: 'current', protocol: 'THORChain', chain: 'ETH', sources: 3 }
      return text(assessSigningRisk(info))
    }
    const old = await at('7.14.2')
    expect(old).toContain('its "Using Asgard vault" screen shows the address but is not a check')
    expect(old).not.toContain('UNVERIFIED')
    expect(await at('7.16.0')).toContain('it labels this one UNVERIFIED')
    // The 7.15 builds disagree (release/7.15 "Using Asgard vault", 7.15-b6
    // "Pays UNVERIFIED vault"): name no screen.
    const mid = await at('7.15.0')
    expect(mid).toContain('so its screen shows the address but is not a check')
    expect(mid).not.toContain('UNVERIFIED')
    expect(mid).not.toContain('Asgard')
  })

  test('typed data before 7.15: the device shows only hashes, not raw data (approvals A6)', () => {
    const doc = cowPermit.typedData
    const typedDataDecoded = decodeEIP712(doc)
    const info = {
      id: 't', method: '/eth/sign-typed-data', appName: 'dapp', chain: 'eth', from: doc.message.owner, chainId: 1, firmwareVersion: '7.14.2',
      typedDataDecoded, recognizedSpender: recognizedTypedDataSpender(typedDataDecoded, 1),
    } as SigningRequestInfo
    applyTypedDataSigningGate(info, doc, '7.14.2')
    const t = text(assessSigningRisk(info))
    expect(t).toContain("KeepKey firmware 7.14.2 cannot show this ERC-2612 Permit on the device yet: it shows only the signature's hash codes")
    expect(t).not.toContain('raw data')
  })

  test('an unlimited Permit2 PermitSingle names its one token, not all of yours (approvals A7)', () => {
    const doc = oneInchPermit2.typedData
    const typedDataDecoded = decodeEIP712(doc)
    const info = {
      id: 't', method: '/eth/sign-typed-data', appName: 'dapp', chain: 'eth', from: doc.message.owner, chainId: 1, firmwareVersion: '7.16.0',
      typedDataDecoded, recognizedSpender: recognizedTypedDataSpender(typedDataDecoded, 1),
    } as SigningRequestInfo
    const t = text(assessSigningRisk(info))
    expect(t).toContain(`spend ALL of token ${doc.message.details.token}, now and later`)
    expect(t).not.toContain('ALL of your tokens')
  })

  test('7.16 native approve: the card names the certified schema the device is sent (approvals A1)', async () => {
    const body = swapsProApprove.body
    globalThis.fetch = (async (url: any, init: any) => {
      const path = new URL(String(url)).pathname
      const req = init?.body ? JSON.parse(init.body) : {}
      if (path === '/v1/evm/schema' && req.chainId === 1 && req.contract === body.to) return Response.json(usdcSchema)
      return Response.json({ classification: 'OPAQUE' }, { status: 422 })
    }) as unknown as typeof fetch
    const info = { id: 'a', method: '/eth/sign-transaction', appName: 'swaps.pro', chain: 'eth', from: body.from, to: body.to, value: body.value, data: body.data, chainId: 1, firmwareVersion: '7.16.0' } as SigningRequestInfo
    await prepareEvmTxSigningInfo(info, { ...body, chainId: 1 }, '7.16.0')
    expect(info.deviceClearSigns).toBe(true)
    expect(info.needsBlindSigning).toBe(false)
    expect(info.certifiedEvmSchema?.signedPayload).toBe(usdcSchema.signedPayload)
    const { descriptor } = evmSigningVerdict(info, {}, { status: 'unavailable' } as any, false)
    expect(descriptor.source).toBe('certified')
    expect(descriptor.label).toBe(usdcSchema.method)
  })
})
