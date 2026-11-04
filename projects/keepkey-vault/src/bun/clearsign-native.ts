/**
 * Coverage observations for what the KeepKey shows from its own decode, and
 * the in-app boundaries that record one per signature: swaps (vault-swap) and
 * Desktop's own signers (vault-rpc). Telemetry only: these predictions never
 * relax a signing gate.
 */
import type { ChainDef } from '../shared/chains'
import type { ClearSignDefinitionResolution, ClearSignDefinitionSource, ClearSignObservationChain, ClearSignObservationDraft } from '../shared/types'
import { deviceErrorMessage } from '../shared/device-error'
import { firmwareClearSigns } from './calldata-decoder'
import { classifyEffectExposure, observeEvmCall, observeMalformedSolanaTransaction, observeSigningRequest, observeSolanaTransaction, transactionShownNatively } from './clearsign-observation'
import { auditUnknownClearSignShape } from './clearsign-live-auditor'
import { authenticateClearSignObservation, finalizeClearSignObservation, insertClearSignObservation } from './db'
import { buildSolanaDecodedInfo } from './solana-clearsign'
import { ethMessagePreview } from './eth-message-preview'
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
      route: `swap:${input.chainFamily}`,
      // Same per-chain rule as REST and in-app sends: outputs and OP_RETURN
      // memo, MsgDeposit memo, XRP destination tag and "Send Hive" are shown
      // field by field; Tron only for what its parser clear-signs; TON never.
      native: transactionShownNatively(swapChain(input.chainFamily, input.chainId), input.tx?.rawTx ?? input.tx?.raw_tx, firmwareVersion),
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

export interface VaultRpcObservationContext {
  isPassphraseWallet: () => boolean
  firmwareVersion: () => string | undefined
  deviceId: () => string | undefined
}

/** ethSignTx (vault-rpc: in-app sends, extension calls): the row for one call,
 *  native when the device decodes it. Hidden wallets record nothing. */
export function recordVaultRpcEvmCall(ctx: VaultRpcObservationContext, input: {
  params: any; source: ClearSignDefinitionSource; definitionResolution: ClearSignDefinitionResolution; evmEndpoint: (chainId: number) => string
}): string | undefined {
  if (ctx.isPassphraseWallet()) return undefined
  const { to, data, value } = input.params ?? {}
  const chainId = Number(input.params?.chainId || 1)
  const draft = observeEvmCall({
    chainId, to, data, source: input.source,
    native: evmShownNatively({ to, data, value, chainId }, ctx.firmwareVersion()),
    definitionResolution: input.definitionResolution,
  })
  const id = insertClearSignObservation(draft, { deviceId: ctx.deviceId(), source: 'vault-rpc' }).id
  void auditUnknownClearSignShape(draft, { evm: input.evmEndpoint(chainId) })
  return id
}

/** solanaSignTx (vault-rpc): the same for a Solana transaction. Malformed input
 *  records nothing here; the signing helper rejects it. */
export async function recordVaultRpcSolanaTransaction(ctx: VaultRpcObservationContext, input: {
  rawTx: string; schema?: unknown; source: ClearSignDefinitionSource; definitionResolution: ClearSignDefinitionResolution; solanaEndpoint: string
}): Promise<string | undefined> {
  if (ctx.isPassphraseWallet()) return undefined
  try {
    const draft = observeSolanaTransaction({
      rawTxBase64: input.rawTx, source: input.source,
      native: await solanaShownNatively(input.rawTx, ctx.firmwareVersion(), input.schema),
      definitionResolution: input.definitionResolution,
    })
    const id = insertClearSignObservation(draft, { deviceId: ctx.deviceId(), source: 'vault-rpc' }).id
    void auditUnknownClearSignShape(draft, { solana: input.solanaEndpoint })
    return id
  } catch { return undefined }
}

const RPC_TRANSACTION_CHAIN = {
  btcSignTx: 'UTXO', btcPsbtSign: 'UTXO', cosmosSignTx: 'Cosmos', thorchainSignTx: 'THORChain', mayachainSignTx: 'Mayachain',
  osmosisSignTx: 'Osmosis', xrpSignTx: 'XRP', tronSignTx: 'Tron', tonSignTx: 'TON', hiveSignTx: 'Hive',
} as const satisfies Record<string, ClearSignObservationChain>
const RPC_MESSAGE_CHAIN = {
  ethSignMessage: 'Ethereum', solanaSignMessage: 'Solana', solanaSignOffchainMessage: 'Solana',
  tronSignMessage: 'Tron', tronSignTypedHash: 'Tron', tonSignMessage: 'TON',
} as const satisfies Record<string, ClearSignObservationChain>
export type VaultRpcSigner = keyof typeof RPC_TRANSACTION_CHAIN | keyof typeof RPC_MESSAGE_CHAIN

/** The bytes hdwallet sends for a message: Uint8Array as is; a string is UTF-8,
 *  except SolanaSignMessage, which reads hex or base64 (hdwallet solana.ts). */
function rpcMessageBytes(method: VaultRpcSigner, message: unknown): Buffer | undefined {
  if (message instanceof Uint8Array) return Buffer.from(message)
  if (typeof message !== 'string') return undefined
  if (method !== 'solanaSignMessage') return Buffer.from(message, 'utf8')
  return /^(?:[0-9a-fA-F]{2})+$/.test(message) ? Buffer.from(message, 'hex') : Buffer.from(message, 'base64')
}

/** Text the device pages as text: valid UTF-8 without control characters
 *  other than tab and newlines. */
function readableText(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)
  } catch { return false }
}

/**
 * The observation for one of Desktop's own signers (vault-rpc), at the level
 * the device shows, by the same per-chain rules as REST. Messages: an Ethereum
 * message that decodes as UTF-8, Tron and Solana off-chain text, Solana plain
 * text (printable ASCII; the signer is not derived on this path, so the
 * firmware's own-key check is not repeated). A typed hash and a TON message
 * are always blind.
 */
export function vaultRpcSigningDraft(method: VaultRpcSigner, params: any, firmwareVersion: string | undefined): ClearSignObservationDraft {
  const route = `vault-rpc:${method}`
  if (method in RPC_TRANSACTION_CHAIN) {
    const chain = RPC_TRANSACTION_CHAIN[method as keyof typeof RPC_TRANSACTION_CHAIN]
    const msgs = params?.tx?.msg
    const msgTypes = Array.isArray(msgs)
      ? msgs.slice(0, 16).map((m: any) => typeof m?.type === 'string' ? m.type.slice(0, 128) : 'unknown') : undefined
    return observeSigningRequest({
      chain, requestKind: 'transaction', route,
      native: transactionShownNatively(chain, params?.rawTx, firmwareVersion),
      ...(msgTypes ? { detail: { msgTypes } } : {}),
    })
  }
  const chain = RPC_MESSAGE_CHAIN[method as keyof typeof RPC_MESSAGE_CHAIN]
  const bytes = method === 'ethSignMessage' ? undefined : rpcMessageBytes(method, params?.message)
  const readable = method === 'ethSignMessage' ? ethMessagePreview('', params?.message).isUtf8Text
    : !bytes ? false
      : method === 'solanaSignMessage' ? bytes.length > 0 && bytes.every(b => (b >= 0x20 && b <= 0x7e) || b === 0x0a)
        : method === 'tronSignMessage' || method === 'solanaSignOffchainMessage' ? readableText(bytes)
          : false
  return observeSigningRequest({
    chain, requestKind: 'message', route, native: readable,
    detail: readable ? { format: 'text' } : { format: 'bytes', ...(bytes ? { byteLength: bytes.length } : {}) },
  })
}

/** One row per signature from Desktop's own signers (in-app sends, PSBTs,
 *  messages), finalized signed / rejected / failed. Hidden wallets record nothing. */
export async function observeVaultRpcSignature<T>(
  ctx: VaultRpcObservationContext, method: VaultRpcSigner, params: unknown, sign: () => Promise<T>,
): Promise<T> {
  if (ctx.isPassphraseWallet()) return sign()
  const observation = insertClearSignObservation(vaultRpcSigningDraft(method, params, ctx.firmwareVersion()), { deviceId: ctx.deviceId(), source: 'vault-rpc' })
  try {
    const result = await sign()
    finalizeClearSignObservation(observation.id, 'signed')
    return result
  } catch (error: any) {
    const rejected = /reject|cancel|denied/i.test(deviceErrorMessage(error))
    finalizeClearSignObservation(observation.id, rejected ? 'rejected' : 'failed', rejected ? 'user-rejected' : 'device-or-transport')
    throw error
  }
}
