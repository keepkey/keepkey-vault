/**
 * Coverage observations for what the KeepKey shows from its own decode, and
 * the in-app swap signature boundary that records one for every swap
 * signature. Telemetry only: these predictions never relax a signing gate.
 */
import type { ChainDef } from '../shared/chains'
import type { ClearSignObservationChain, ClearSignObservationDraft } from '../shared/types'
import { deviceErrorMessage } from '../shared/device-error'
import { firmwareClearSigns } from './calldata-decoder'
import { classifyEffectExposure, observeEvmCall, observeMalformedSolanaTransaction, observeSigningRequest, observeSolanaTransaction } from './clearsign-observation'
import { auditUnknownClearSignShape } from './clearsign-live-auditor'
import { authenticateClearSignObservation, finalizeClearSignObservation, insertClearSignObservation } from './db'
import { buildSolanaDecodedInfo } from './solana-clearsign'
import { requiresSolanaBlindSigningConsent, solanaFirmwareRequiresAdvancedMode } from './solana-consent'

/** A plain transfer, or a call the firmware decodes itself (a THORChain or
 *  Maya router deposit, a token transfer the firmware's token table knows). */
export function evmShownNatively(
  tx: { to?: string; data?: string; value?: unknown; chainId?: number }, firmwareVersion: string | undefined,
): boolean {
  if (!tx.data || tx.data === '0x') return Boolean(tx.to)
  return firmwareClearSigns(tx.to, tx.data, tx.chainId, firmwareVersion, tx.value)
}

/** The device reviews every instruction itself: the same two checks the
 *  Solana approval card's verdict uses (solanaSigningVerdict). Lookup tables
 *  are never fetched here, so a transaction that needs one is not native. */
export async function solanaShownNatively(
  rawTxBase64: string, firmwareVersion: string | undefined, schema?: unknown,
): Promise<boolean> {
  try {
    if (solanaFirmwareRequiresAdvancedMode(rawTxBase64, firmwareVersion, schema ? { schema } : {})) return false
    const decoded = await buildSolanaDecodedInfo(rawTxBase64, async (keys) => keys.map(() => null))
    return !requiresSolanaBlindSigningConsent(decoded, false)
  } catch {
    return false
  }
}

// Families whose swap signature the device shows field by field (outputs and
// OP_RETURN memo, MsgDeposit memo, XRP destination tag); no blind-sign path
// exists for them. Tron, TON and Hive swaps are not predicted here and are
// recorded as not native.
const SWAP_NATIVE_FAMILIES = new Set<ChainDef['chainFamily']>(['utxo', 'zcash-shielded', 'cosmos', 'xrp'])

function swapChain(family: ChainDef['chainFamily'], chainId?: string): ClearSignObservationChain {
  if (family === 'cosmos') {
    const id = String(chainId || '')
    return id.startsWith('thorchain') ? 'THORChain' : id.startsWith('mayachain') ? 'Mayachain'
      : id.startsWith('osmosis') ? 'Osmosis' : 'Cosmos'
  }
  const byFamily: Record<string, ClearSignObservationChain> = {
    utxo: 'UTXO', 'zcash-shielded': 'Zcash', xrp: 'XRP', tron: 'Tron', ton: 'TON', hive: 'Hive',
  }
  return byFamily[family] ?? 'UTXO'
}

export interface SwapSignatureContext {
  isPassphraseWallet: () => boolean
  firmwareVersion: () => string | undefined
  deviceId: () => string | undefined
  evmEndpoint: (chainId: number) => string
  solanaEndpoint: () => string
}

/** SwapContext.protectSign: one observation per swap signature, hidden
 *  (passphrase) wallets excepted. */
export async function protectSwapSignature(
  ctx: SwapSignatureContext,
  input: { chainFamily: ChainDef['chainFamily']; chainId?: string; from: string; tx: any; kind: 'approval' | 'swap' },
  sign: () => Promise<any>,
): Promise<any> {
  if (ctx.isPassphraseWallet()) return sign()
  const firmwareVersion = ctx.firmwareVersion()
  let draft: ClearSignObservationDraft
  if (input.chainFamily === 'evm') {
    const chainId = Number(input.tx.chainId || input.chainId || 1)
    const { simulateEvmEffects } = await import('./evm-effects')
    const simulation = await simulateEvmEffects({
      chainId, from: input.from, to: input.tx.to, data: input.tx.data || '0x', value: input.tx.value || '0x0',
      gas: input.tx.gas || input.tx.gasLimit, gasPrice: input.tx.gasPrice,
      maxFeePerGas: input.tx.maxFeePerGas, maxPriorityFeePerGas: input.tx.maxPriorityFeePerGas, nonce: input.tx.nonce,
    }, ctx.evmEndpoint(chainId))
    const native = evmShownNatively({ to: input.tx.to, data: input.tx.data, value: input.tx.value, chainId }, firmwareVersion)
    draft = observeEvmCall({
      chainId, to: input.tx.to, data: input.tx.data,
      source: input.tx.erc7730 ? 'erc7730' : input.tx.txMetadata ? 'runtime' : 'none',
      native,
      simulated: simulation.status === 'success',
      simulationStatus: simulation.status,
      exposureClass: classifyEffectExposure(simulation),
    })
    // Attachment presence is not authentication. Promote only after the
    // device accepts the exact definition and transaction below.
    if (!native) draft.protectionLevel = simulation.status === 'success' ? 'P3' : 'P1'
  } else if (input.chainFamily === 'solana') {
    const rawTx = input.tx.rawTx || input.tx.raw_tx
    try {
      const { simulateSolanaEffects } = await import('./solana-effects')
      const simulation = await simulateSolanaEffects(rawTx, input.from, ctx.solanaEndpoint())
      const native = await solanaShownNatively(rawTx, firmwareVersion, input.tx.schema)
      draft = observeSolanaTransaction({ rawTxBase64: rawTx, source: input.tx.schema ? 'runtime' : 'none', native, simulated: simulation.status === 'success', simulationStatus: simulation.status, exposureClass: classifyEffectExposure(simulation) })
      if (!native) draft.protectionLevel = simulation.status === 'success' ? 'P3' : 'P1'
    } catch { draft = observeMalformedSolanaTransaction(String(rawTx || '')) }
  } else {
    draft = observeSigningRequest({
      chain: swapChain(input.chainFamily, input.chainId), requestKind: 'transaction',
      route: `swap:${input.chainFamily}`, native: SWAP_NATIVE_FAMILIES.has(input.chainFamily),
    })
  }
  const observation = insertClearSignObservation(draft, { deviceId: ctx.deviceId(), source: 'vault-swap' })
  void auditUnknownClearSignShape(draft, {
    evm: draft.chain === 'Ethereum' ? ctx.evmEndpoint(Number(draft.shape.chainId || 1)) : undefined,
    solana: ctx.solanaEndpoint(),
  })
  try {
    const result = await sign()
    if (input.tx.erc7730 || input.tx.txMetadata || input.tx.schema || result?.clearSignPromotionBundleHash) authenticateClearSignObservation(
      observation.id, input.tx.erc7730 ? 'erc7730' : input.tx.txMetadata?.keyId === 0x80 || result?.clearSignPromotionBundleHash ? 'certified' : 'runtime',
      1, Boolean(result?.clearSignPromotionBundleHash), result?.clearSignPromotionBundleHash,
    )
    finalizeClearSignObservation(observation.id, 'signed')
    return result
  } catch (error: any) {
    const rejected = /reject|cancel|denied/i.test(deviceErrorMessage(error))
    finalizeClearSignObservation(observation.id, rejected ? 'rejected' : 'failed', rejected ? 'user-rejected' : 'device-or-transport')
    throw error
  }
}
