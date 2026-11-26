/**
 * Magi swaps wired to the connected KeepKey: account, capability, quotes kept
 * server-side, the two signing paths, direct broadcast and persisted records.
 *
 * The webview never sends operations to sign. It asks for a quote, gets a
 * quoteId, and executes that id; the ops come from this process's own copy,
 * already split and checked by splitMagiOps.
 */
import { hiveRolePath } from '../../shared/chains'
import type { MagiAsset, MagiQuoteView } from '../../shared/magi-config'
import { getHiveOpsCapability } from '../hive-ops-capability'
import { assembleSignedHiveTx, broadcastSignedHiveTx, hiveTxId } from '../txbuilder/hive-broadcast'
import {
	expectedHiveSignTxTransferBytes, HIVE_MAINNET_CHAIN_ID, serializeHiveOpsTx,
	type HiveOpTuple, type HiveTxHeader,
} from '../txbuilder/hive-ops'
import {
	executeMagiHiveOut, getMagiBtcDeposit, quoteMagiHiveOut, retryMagiSwap, toRaw, withdrawFromMagi,
	type MagiExecDeps, type MagiQuote, type MagiSwapRecord,
} from './magi'
import { formatMilli, type MagiHiveAsset } from './magi-ledger'
import { hiveRcReader, loadMagiLedger, loadMagiSdk, magiReferralActive } from './magi-sdk'

export interface MagiRuntimeContext {
	wallet: any
	deviceState: { deviceId?: string; firmwareHash?: string; initialized?: boolean; bootloaderMode?: boolean; state?: string }
	pioneerBase: string
	/** Wraps a device prompt (emulator confirm gate; plain call on a real device). */
	signOp<T>(fn: () => Promise<T>, details: { operation: string; chain: string; to?: string; value?: string }): Promise<T>
	/** Persisted state; null for passphrase wallets (nothing written to disk). */
	store: { get(key: string): string | null; set(key: string, value: string): void } | null
}

const QUOTE_TTL_MS = 60_000
const quotes = new Map<string, { quote: MagiQuote; expires: number }>()

function keepQuote(quote: MagiQuote): string {
	const now = Date.now()
	for (const [k, v] of quotes) if (v.expires <= now) quotes.delete(k)
	const id = crypto.randomUUID()
	quotes.set(id, { quote, expires: now + QUOTE_TTL_MS })
	return id
}

function takeQuote(id: string): MagiQuote {
	const row = quotes.get(id)
	quotes.delete(id) // single use
	if (!row || row.expires <= Date.now()) throw new Error('This Magi quote expired. Get a new quote.')
	return row.quote
}

// ── Account ──────────────────────────────────────────────────────────

/** The Hive account controlled by the device's active key (account 0). */
export async function resolveMagiAccount(ctx: MagiRuntimeContext): Promise<string> {
	const key = await ctx.wallet.hiveGetPublicKey({ addressNList: hiveRolePath('active', 0), showDisplay: false })
	if (!key?.publicKey) throw new Error('Could not read the Hive key from your KeepKey')
	const resp = await fetch(`${ctx.pioneerBase}/api/v1/hive/account/${encodeURIComponent(key.publicKey)}`, { signal: AbortSignal.timeout(15_000) })
	const data: any = await resp.json()
	const name = data?.account?.name
	if (!name) throw new Error('No Hive account found for this KeepKey')
	return name
}

// ── Capability ───────────────────────────────────────────────────────

export async function magiCapability(ctx: MagiRuntimeContext) {
	const s = ctx.deviceState
	if (!ctx.wallet || s.bootloaderMode || s.state !== 'ready') {
		return getHiveOpsCapability(null, { deviceId: s.deviceId, firmwareHash: s.firmwareHash })
	}
	// Fresh features: a cached "PIN unlocked" may be stale after an auto-lock,
	// and the probe must never trigger the PIN prompt. GetFeatures shows nothing.
	let features: any = null
	try { features = await ctx.wallet.getFeatures(false) } catch { /* treat as locked */ }
	return getHiveOpsCapability(ctx.wallet, {
		deviceId: s.deviceId,
		firmwareHash: s.firmwareHash,
		initialized: !!features?.initialized,
		pinProtection: features ? !!features.pinProtection : true,
		pinCached: !!features?.pinCached,
		bootloaderMode: !!features?.bootloaderMode,
	})
}

// ── Signing paths ────────────────────────────────────────────────────

async function txHeader(ctx: MagiRuntimeContext): Promise<HiveTxHeader> {
	const r: any = await fetch(`${ctx.pioneerBase}/api/v1/hive/tx-params`, { signal: AbortSignal.timeout(20_000) }).then(x => x.json())
	if (!r?.success) throw new Error(`Hive tx-params failed: ${r?.error || 'unknown'}`)
	return { refBlockNum: r.refBlockNum, refBlockPrefix: r.refBlockPrefix, expirationUnix: r.expirationUnix, chainId: r.chainId || HIVE_MAINNET_CHAIN_ID }
}

function stripChainId(bytes: Uint8Array, chainId: string): Buffer {
	const b = Buffer.from(bytes)
	return b.length > 32 && b.subarray(0, 32).toString('hex') === chainId.toLowerCase() ? b.subarray(32) : b
}

/** Step 1: the deposit transfer on the dedicated HiveSignTx path. */
export async function signAndBroadcastDeposit(ctx: MagiRuntimeContext, op: HiveOpTuple): Promise<{ txid: string }> {
	if (op[0] !== 'transfer') throw new Error('Only a transfer can go through HiveSignTx')
	const t = op[1] as { from: string; to: string; amount: string; memo?: string }
	const m = /^(\d+)\.(\d{3}) (HIVE|HBD)$/.exec(t.amount)
	if (!m) throw new Error('Malformed deposit amount')
	const header = await txHeader(ctx)
	const signed: any = await ctx.signOp(() => ctx.wallet.hiveSignTx({
		addressNList: hiveRolePath('active', 0),
		chainId: header.chainId,
		refBlockNum: header.refBlockNum,
		refBlockPrefix: header.refBlockPrefix,
		expiration: header.expirationUnix,
		from: t.from, to: t.to,
		amount: Number(BigInt(m[1]!) * 1000n + BigInt(m[2]!)),
		decimals: 3,
		assetSymbol: m[3],
		memo: t.memo ?? '',
	}), { operation: 'hiveSignTx', chain: 'Hive', to: t.to, value: t.amount })
	if (!signed?.signature || !signed?.serializedTx) throw new Error('KeepKey returned no Hive signature')

	// The node re-serializes the JSON we send; it must be the exact bytes signed.
	const deviceBytes = stripChainId(signed.serializedTx, header.chainId)
	const expected = expectedHiveSignTxTransferBytes({ ...header, from: t.from, to: t.to, amount: t.amount, memo: t.memo })
	if (deviceBytes.toString("hex") !== expected.toString("hex")) throw new Error('The KeepKey signed different bytes than expected for this deposit. Nothing was sent.')

	const txid = hiveTxId(deviceBytes, header.chainId)
	const tx = assembleSignedHiveTx({ header, operations: [op], signature: signed.signature })
	return broadcastSignedHiveTx(tx, txid)
}

/** Step 2 (and withdrawals): custom_json through HiveSignOperations. */
export async function signAndBroadcastOps(ctx: MagiRuntimeContext, ops: HiveOpTuple[]): Promise<{ txid: string }> {
	const header = await txHeader(ctx)
	const serialized = serializeHiveOpsTx({ ...header, operations: ops })
	if (serialized.tier !== 'active') throw new Error('Magi operations must be signed with the active key')
	const signed: any = await ctx.signOp(() => ctx.wallet.hiveSignOperations({
		addressNList: hiveRolePath('active', 0),
		chainId: header.chainId,
		serializedTx: new Uint8Array(serialized.serializedTx),
	}), { operation: 'hiveSignOperations', chain: 'Hive', to: String(ops[0]?.[1]?.id ?? ''), value: '' })
	if (!signed?.signature) throw new Error('KeepKey returned no Hive signature')
	const txid = hiveTxId(serialized.serializedTx, header.chainId)
	return broadcastSignedHiveTx(assembleSignedHiveTx({ header, operations: ops, signature: signed.signature }), txid)
}

// ── Records ──────────────────────────────────────────────────────────

const recordsKey = (deviceId?: string) => `magi_swaps:${deviceId ?? 'unknown'}`

export function listMagiRecords(ctx: MagiRuntimeContext): MagiSwapRecord[] {
	if (!ctx.store) return [...memoryRecords.values()]
	try { return JSON.parse(ctx.store.get(recordsKey(ctx.deviceState.deviceId)) || '[]') } catch { return [] }
}

const memoryRecords = new Map<string, MagiSwapRecord>()

function saveRecord(ctx: MagiRuntimeContext, record: MagiSwapRecord) {
	if (!ctx.store) { memoryRecords.set(record.id, record); return }
	const all = listMagiRecords(ctx).filter(r => r.id !== record.id)
	all.unshift(record)
	ctx.store.set(recordsKey(ctx.deviceState.deviceId), JSON.stringify(all.slice(0, 50)))
}

async function execDeps(ctx: MagiRuntimeContext): Promise<MagiExecDeps> {
	const [{ sdk }, ledger] = await Promise.all([loadMagiSdk(), loadMagiLedger()])
	return {
		signAndBroadcastDeposit: (op) => signAndBroadcastDeposit(ctx, op),
		signAndBroadcastOps: (ops) => signAndBroadcastOps(ctx, ops),
		getCapability: () => magiCapability(ctx),
		sdk, hiveRc: hiveRcReader, ledger,
		save: (r) => saveRecord(ctx, r),
		referralActive: magiReferralActive,
	}
}

// ── Public operations (RPC handlers call these) ──────────────────────


export async function getMagiQuote(ctx: MagiRuntimeContext, params: { from: MagiHiveAsset; to: MagiAsset; amount: string; btcAddress?: string }): Promise<MagiQuoteView> {
	const [{ sdk }, username, capability, referralActive] = await Promise.all([loadMagiSdk(), resolveMagiAccount(ctx), magiCapability(ctx), magiReferralActive()])
	const quote = await quoteMagiHiveOut({ sdk, hiveRc: hiveRcReader, capability, username, referralActive, ...params })
	const quoteId = keepQuote(quote)
	const { ops: _ops, ...view } = quote
	return { ...view, quoteId }
}

export async function executeMagiQuote(ctx: MagiRuntimeContext, quoteId: string): Promise<MagiSwapRecord> {
	const quote = takeQuote(quoteId)
	return executeMagiHiveOut(quote, await execDeps(ctx), crypto.randomUUID())
}

export async function retryMagiRecord(ctx: MagiRuntimeContext, id: string): Promise<MagiSwapRecord> {
	const record = listMagiRecords(ctx).find(r => r.id === id)
	if (!record) throw new Error('Swap not found')
	if (record.stage !== 'needs-attention' && record.stage !== 'deposit-credited') throw new Error('This swap has nothing to retry')
	const deps = await execDeps(ctx)
	// Funds must actually be there before a second signature.
	const bal = await deps.ledger.getBalance(record.username)
	const need = toRaw(record.amountIn, record.from)
	if ((record.from === 'HBD' ? bal.hbd : bal.hive) < need) {
		throw new Error(`Your Magi balance has ${formatMilli(record.from === 'HBD' ? bal.hbd : bal.hive)} ${record.from}; the deposit may not be credited yet.`)
	}
	return retryMagiSwap(record, deps)
}

export async function getMagiBalance(ctx: MagiRuntimeContext) {
	const [ledger, username] = await Promise.all([loadMagiLedger(), resolveMagiAccount(ctx)])
	const b = await ledger.getBalance(username)
	return { username, hive: formatMilli(b.hive), hbd: formatMilli(b.hbd) }
}

export async function withdrawMagi(ctx: MagiRuntimeContext, params: { asset: MagiHiveAsset; amount?: string }) {
	const [deps, username] = await Promise.all([execDeps(ctx), resolveMagiAccount(ctx)])
	const amount = params.amount ? toRaw(params.amount, params.asset) : undefined
	const r = await withdrawFromMagi({ username, asset: params.asset, amount }, deps)
	return { txid: r.txid, amount: formatMilli(r.amount), asset: params.asset }
}

/** BTC → HIVE/HBD: the deposit address, only when the user continues. */
export async function getMagiBtcDepositAddress(ctx: MagiRuntimeContext, assetOut: MagiHiveAsset) {
	const [{ sdk }, username] = await Promise.all([loadMagiSdk(), resolveMagiAccount(ctx)])
	const { address } = await getMagiBtcDeposit(sdk, username, assetOut)
	return { address, username, assetOut }
}
