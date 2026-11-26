/**
 * Magi (VSC) swaps between HIVE, HBD and BTC, signed on a KeepKey.
 *
 * HIVE/HBD OUT — two transactions, never one.
 * Magi's quick swap is [deposit transfer → vsc.gateway, swap custom_json].
 * The KeepKey signs a transfer only on its dedicated HiveSignTx path; op 2 is
 * excluded from HiveSignOperations on purpose (txbuilder/hive-ops.ts header)
 * and stays excluded. So:
 *   1. the deposit is signed with HiveSignTx and broadcast;
 *   2. once Magi's ledger shows it credited (same block, ~3–6 s indexing),
 *      the swap is simulated against the real balance (simOk is now
 *      meaningful), its rc_limit tightened, then signed with
 *      HiveSignOperations and broadcast.
 * Separating them is safe (Skatehive Coder, 2026-11-26): the swap's
 * transfer.allow intent pulls from the caller's Magi balance at execution
 * time, whichever transaction credited it.
 *
 * NOTHING IS SIGNED UNLESS BOTH STEPS CAN RUN. Before the deposit: the device
 * must have HiveSignOperations, the Hive account must have the liquid balance
 * and the resource credits for two transactions, and Magi must have RC for
 * the call. If step 2 still fails, the deposit is the user's own Magi
 * balance: the record says so, and the user can retry the swap or withdraw
 * back to the Hive account. Never a silent stop.
 *
 * BTC IN — Magi's mapping bot returns a deposit address per (user, asset);
 * the vault sends BTC to it as a plain deposit. The address is requested only
 * when the user continues (it creates a real mapping), never while quoting.
 */
import {
	findMagiRoute, magiRouteAvailability, MAGI_REFERRAL, MAGI_SLIPPAGE_BPS,
	isValidBtcAddress, type HiveOpsCapability, type MagiAsset, type MagiRoute,
} from '../../shared/magi-config'
import type { HiveOpTuple } from '../txbuilder/hive-ops'
import { formatMilli, type MagiHiveAsset, type MagiLedger } from './magi-ledger'

// ── SDK surface used here (kept narrow so tests can stub it) ─────────

export interface MagiCalc { expectedOutput: bigint; minAmountOut: bigint; totalFee: bigint; hops?: 1 | 2 }
export interface MagiBuild { ops: unknown[]; preview: MagiCalc; referralApplied: boolean }
export interface MagiRcCheck {
	simOk: boolean; rcUsed: bigint; rcAvailable: bigint; sufficient: boolean
	broadcastRcLimit: number; err?: string; errMsg?: string
}
export interface MagiSdk {
	/** withReferral: false builds with no referral at all (beneficiary account missing). */
	buildQuickSwap(input: { username: string; assetIn: 'HIVE' | 'HBD'; amountIn: unknown; assetOut: MagiAsset; recipient: string; slippageBps?: number; withReferral: boolean }): Promise<MagiBuild>
	coinAmount(decimal: string, asset: MagiHiveAsset): unknown
	/** Liquid balance on the Hive account (L1), milli-units. */
	getLiquidBalance(username: string, asset: MagiHiveAsset): Promise<bigint | null>
	checkSwapRc(username: string, swapOp: HiveOpTuple): Promise<MagiRcCheck>
	requiredRc(swapOp: HiveOpTuple): bigint
	withSwapOpRcLimit(swapOp: HiveOpTuple, rcLimit: number): HiveOpTuple
	getBtcDepositAddress(req: { recipient: string; assetOut: MagiHiveAsset; destinationChain: 'HIVE' }): Promise<{ address: string }>
}

/** Hive account resource credits (L1), with regeneration applied. */
export interface HiveRcReader { currentMana(username: string): Promise<{ current: bigint; max: bigint }> }

/**
 * Rough RC cost of one small transaction (a transfer or one custom_json).
 * rc_api only reports an account's mana, not what an operation costs; the
 * exact cost needs the node's resource-pool formula. TODO(magi): replace with
 * a cost computed from rc_api.get_resource_params / get_resource_pool, or
 * measured on mainnet. Errs high on purpose: a deposit must never be sent by
 * an account that cannot afford the second transaction.
 */
export const HIVE_RC_PER_TX_ESTIMATE = 2_000_000_000n
export const MAGI_DEPOSIT_TXS = 2n
const RC_NEEDED = HIVE_RC_PER_TX_ESTIMATE * MAGI_DEPOSIT_TXS

/** Hours until regeneration covers the shortfall (full recharge = 5 days). */
function hoursToRegen(shortfall: bigint, max: bigint): number {
	if (max <= 0n) return Infinity
	return Math.ceil(Number((shortfall * 120n * 1000n) / max) / 1000)
}

/** Null when the account can afford both transactions; else the block text. */
export function hiveRcShortfall(rc: { current: bigint; max: bigint }): string | null {
	if (rc.current >= RC_NEEDED) return null
	const short = RC_NEEDED - rc.current
	const billions = (Number(short) / 1e9).toFixed(1)
	const hours = hoursToRegen(short, rc.max)
	const wait = Number.isFinite(hours) ? `wait about ${hours} h for them to regenerate` : 'wait for them to regenerate'
	return `Not enough Hive Resource Credits for the two transactions this swap needs: about ${billions} billion RC short. Power up some HIVE, or ${wait}.`
}

// ── Amounts ──────────────────────────────────────────────────────────

const DECIMALS: Record<MagiAsset, number> = { HIVE: 3, HBD: 3, BTC: 8 }

/** Truncate (never round up) a decimal string to the asset's precision. */
export function truncateAmount(amount: string, asset: MagiAsset): string {
	const s = String(amount).trim()
	if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Enter a valid amount')
	const [i, f = ''] = s.split('.')
	const d = DECIMALS[asset]
	return d ? `${BigInt(i!)}.${f.slice(0, d).padEnd(d, '0')}` : String(BigInt(i!))
}

export function toRaw(amount: string, asset: MagiAsset): bigint {
	const [i, f = ''] = truncateAmount(amount, asset).split('.')
	return BigInt(i!) * 10n ** BigInt(DECIMALS[asset]) + BigInt(f || '0')
}

export function fromRaw(raw: bigint, asset: MagiAsset): string {
	const d = BigInt(DECIMALS[asset])
	const unit = 10n ** d
	return `${raw / unit}.${(raw % unit).toString().padStart(Number(d), '0')}`
}

// ── Ops ──────────────────────────────────────────────────────────────

export interface MagiOpsSplit { deposit: HiveOpTuple; swap: HiveOpTuple }

/**
 * Split Magi's [deposit, swap] into the two device transactions, checking
 * each is exactly what it claims: a transfer from the user to Magi's gateway,
 * and an active-auth vsc.call custom_json from the same user.
 */
export function splitMagiOps(ops: unknown[], username: string, gatewayAccount = 'vsc.gateway'): MagiOpsSplit {
	if (!Array.isArray(ops) || ops.length !== 2) throw new Error('Magi returned an unexpected operation list')
	const [deposit, swap] = ops as HiveOpTuple[]
	if (deposit?.[0] !== 'transfer') throw new Error('Magi deposit is not a transfer')
	const t = deposit[1]
	if (t.from !== username || t.to !== gatewayAccount) throw new Error('Magi deposit has an unexpected sender or recipient')
	if (!/^\d+\.\d{3} (HIVE|HBD)$/.test(String(t.amount))) throw new Error('Magi deposit amount is malformed')
	if (swap?.[0] !== 'custom_json') throw new Error('Magi swap is not a custom_json')
	const c = swap[1]
	if (c.id !== 'vsc.call') throw new Error('Magi swap has an unexpected id')
	if (!Array.isArray(c.required_auths) || c.required_auths.length !== 1 || c.required_auths[0] !== username) {
		throw new Error('Magi swap must be authorised by the same account, with the active key')
	}
	if (Array.isArray(c.required_posting_auths) && c.required_posting_auths.length) throw new Error('Magi swap must not use posting auths')
	return { deposit, swap }
}

/** The swap payload, for display and checks. */
export function readSwapPayload(swap: HiveOpTuple): Record<string, any> {
	const call = JSON.parse(String(swap[1].json))
	return typeof call.payload === 'string' ? JSON.parse(call.payload) : (call.payload ?? {})
}

/**
 * The referral in the signed swap must be exactly what we decided: none when
 * it is off, and only MAGI_REFERRAL when on. A beneficiary is credited on
 * Magi's ledger by name, so a fee to an account nobody holds yet could later
 * be claimed by whoever registers that name.
 */
export function assertSwapReferral(swap: HiveOpTuple, withReferral: boolean): void {
	const p = readSwapPayload(swap)
	if (!withReferral) {
		if (p.beneficiary !== undefined || p.ref_bps !== undefined) throw new Error('Magi swap carries a referral that should be off')
		return
	}
	if (p.beneficiary === undefined && p.ref_bps === undefined) return // SDK did not qualify it (e.g. HIVE/HBD output)
	if (p.beneficiary !== MAGI_REFERRAL.beneficiary || Number(p.ref_bps) !== MAGI_REFERRAL.bps) {
		throw new Error('Magi swap carries an unexpected referral')
	}
}

// ── Quote ────────────────────────────────────────────────────────────

export interface MagiQuote {
	provider: 'Magi'
	route: MagiRoute
	username: string
	amountIn: string
	expectedOut: string
	minOut: string
	/** Referral in bps when Magi applies it (BTC outputs only), else 0. */
	referralBps: number
	hops: 1 | 2
	recipient: string
	ops: MagiOpsSplit
	/** Set when the route must not run; the quote stays visible. */
	blockReason?: string
	/** Pre-deposit simulation failure that is expected (deposit not in ledger yet). */
	simDeferred: boolean
}

/** Simulation failures that only mean "the deposit isn't in the ledger yet". */
export function isPreDepositSimArtifact(rc: Pick<MagiRcCheck, 'simOk' | 'err' | 'errMsg'>): boolean {
	return !rc.simOk && (
		(rc.err === 'ledger_error' && /insufficient balance/i.test(rc.errMsg ?? ''))
		|| (rc.err === 'gas_limit_hit' && /cost limit exceeded/i.test(rc.errMsg ?? ''))
	)
}

export async function quoteMagiHiveOut(params: {
	sdk: MagiSdk
	hiveRc: HiveRcReader
	capability: HiveOpsCapability
	username: string
	from: MagiHiveAsset
	to: MagiAsset
	amount: string
	/** Required for BTC output; ignored otherwise (output goes to the user). */
	btcAddress?: string
	slippageBps?: number
	/** False while the referral beneficiary's Hive account does not exist. */
	referralActive: boolean
}): Promise<MagiQuote> {
	const route = findMagiRoute(params.from, params.to)
	if (!route || route.kind !== 'hive-ops') throw new Error(`Magi has no ${params.from} → ${params.to} route`)
	let recipient: string
	if (params.to === 'BTC') {
		if (!isValidBtcAddress(params.btcAddress)) throw new Error('Enter a valid Bitcoin address')
		recipient = params.btcAddress!.trim()
	} else {
		recipient = `hive:${params.username}`
	}

	const amountIn = truncateAmount(params.amount, params.from)
	const amountRaw = toRaw(amountIn, params.from)
	if (amountRaw <= 0n) throw new Error('Amount must be greater than zero')

	const build = await params.sdk.buildQuickSwap({
		username: params.username,
		assetIn: params.from,
		amountIn: params.sdk.coinAmount(amountIn, params.from),
		assetOut: params.to,
		recipient,
		slippageBps: params.slippageBps ?? MAGI_SLIPPAGE_BPS,
		withReferral: params.referralActive,
	})
	if (build.preview.expectedOutput <= 0n) throw new Error('No route for this pair and amount. Try another amount.')
	let ops = splitMagiOps(build.ops, params.username)
	assertSwapReferral(ops.swap, params.referralActive)

	const quote: MagiQuote = {
		provider: 'Magi', route, username: params.username, amountIn,
		expectedOut: fromRaw(build.preview.expectedOutput, params.to),
		minOut: fromRaw(build.preview.minAmountOut, params.to),
		referralBps: params.referralActive && build.referralApplied ? MAGI_REFERRAL.bps : 0,
		hops: build.preview.hops ?? 1, recipient, ops, simDeferred: false,
	}

	// Gates, most fundamental first. The first one found is the reason shown.
	const availability = magiRouteAvailability(route, params.capability)
	if (!availability.available) return { ...quote, blockReason: availability.reason }

	const [liquid, mana, rc] = await Promise.all([
		params.sdk.getLiquidBalance(params.username, params.from),
		params.hiveRc.currentMana(params.username),
		params.sdk.checkSwapRc(params.username, ops.swap),
	])
	if (liquid === null || liquid < amountRaw) {
		return { ...quote, blockReason: `Not enough liquid ${params.from}: need ${amountIn}, you have ${formatMilli(liquid ?? 0n)} (savings and staked HIVE can't be swapped directly).` }
	}
	const rcBlock = hiveRcShortfall(mana)
	if (rcBlock) return { ...quote, blockReason: rcBlock }
	const requiredRc = params.sdk.requiredRc(ops.swap)
	if (rc.rcAvailable < requiredRc) {
		return { ...quote, blockReason: `Not enough Magi Resource Credits: the swap needs about ${requiredRc} RC and the account has ${rc.rcAvailable}. Holding HBD in Magi raises it.` }
	}
	if (!rc.simOk && !isPreDepositSimArtifact(rc)) {
		return { ...quote, blockReason: `Magi cannot run this swap right now${rc.errMsg ? `: ${rc.errMsg}` : '.'}` }
	}
	if (rc.simOk) ops = { ...ops, swap: params.sdk.withSwapOpRcLimit(ops.swap, rc.broadcastRcLimit) }
	return { ...quote, ops, simDeferred: !rc.simOk }
}

// ── Execution (Hive out) ─────────────────────────────────────────────

export type { MagiSwapStage, MagiSwapRecord } from '../../shared/magi-config'
import type { MagiSwapRecord } from '../../shared/magi-config'

export interface MagiExecDeps {
	/** HiveSignTx on the device, then broadcast. Returns the Hive txid. */
	signAndBroadcastDeposit(op: HiveOpTuple): Promise<{ txid: string }>
	/** HiveSignOperations on the device, then direct broadcast. */
	signAndBroadcastOps(ops: HiveOpTuple[]): Promise<{ txid: string }>
	getCapability(): Promise<HiveOpsCapability>
	sdk: MagiSdk
	hiveRc: HiveRcReader
	ledger: MagiLedger
	save(record: MagiSwapRecord): void | Promise<void>
	/** Whether the referral beneficiary's Hive account exists (see referralActive). */
	referralActive(): Promise<boolean>
	sleep?(ms: number): Promise<void>
	now?(): number
	/** How long to wait for the deposit to show in Magi's ledger. */
	creditTimeoutMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitForCredit(deps: MagiExecDeps, txid: string): Promise<boolean> {
	const sleep = deps.sleep ?? defaultSleep
	const now = deps.now ?? Date.now
	const deadline = now() + (deps.creditTimeoutMs ?? 90_000)
	while (now() < deadline) {
		try { if (await deps.ledger.isDepositCredited(txid)) return true } catch { /* API flake: keep polling */ }
		await sleep(2_000)
	}
	return false
}

/** Simulate against the real balance, tighten rc_limit, sign, broadcast. */
async function runSwapStep(deps: MagiExecDeps, record: MagiSwapRecord, swapOp: HiveOpTuple): Promise<MagiSwapRecord> {
	const update = async (patch: Partial<MagiSwapRecord>) => {
		Object.assign(record, patch, { updatedAt: (deps.now ?? Date.now)() })
		await deps.save({ ...record })
		return record
	}
	const rc = await deps.sdk.checkSwapRc(record.username, swapOp)
	if (!rc.simOk) {
		return update({ stage: 'needs-attention', attention: `Your ${record.amountIn} ${record.from} is in your Magi balance, but the swap can't run right now${rc.errMsg ? ` (${rc.errMsg})` : ''}. Try the swap again, or withdraw it back to your Hive account.` })
	}
	const tightened = deps.sdk.withSwapOpRcLimit(swapOp, rc.broadcastRcLimit)
	await update({ stage: 'signing-swap', attention: undefined })
	try {
		const { txid } = await deps.signAndBroadcastOps([tightened])
		return update({ stage: 'swap-sent', swapTxId: txid })
	} catch (e: any) {
		return update({ stage: 'needs-attention', attention: `Your ${record.amountIn} ${record.from} is in your Magi balance; the swap was not sent (${e?.message || 'cancelled'}). Try the swap again, or withdraw it back to your Hive account.` })
	}
}

/** Run a Hive-out quote end to end. Throws only before anything is signed. */
export async function executeMagiHiveOut(quote: MagiQuote, deps: MagiExecDeps, id: string): Promise<MagiSwapRecord> {
	if (quote.blockReason) throw new Error(quote.blockReason)
	// Re-check the gates at click time: nothing is deposited unless step 2 can run.
	const capability = await deps.getCapability()
	const availability = magiRouteAvailability(quote.route, capability)
	if (!availability.available) throw new Error(availability.reason)
	const rcBlock = hiveRcShortfall(await deps.hiveRc.currentMana(quote.username))
	if (rcBlock) throw new Error(rcBlock)

	const record: MagiSwapRecord = {
		id, username: quote.username, from: quote.route.from as MagiHiveAsset, to: quote.route.to,
		amountIn: quote.amountIn, minOut: quote.minOut, recipient: quote.recipient,
		stage: 'signing-deposit', updatedAt: (deps.now ?? Date.now)(),
	}
	await deps.save({ ...record })

	// Step 1. A cancel or failure here leaves nothing behind: rethrow.
	let depositTxId: string
	try {
		depositTxId = (await deps.signAndBroadcastDeposit(quote.ops.deposit)).txid
	} catch (e) {
		await deps.save({ ...record, stage: 'cancelled', attention: 'Deposit not sent; nothing moved.', updatedAt: (deps.now ?? Date.now)() })
		throw e
	}
	Object.assign(record, { stage: 'deposit-sent', depositTxId, updatedAt: (deps.now ?? Date.now)() })
	await deps.save({ ...record })

	if (!(await waitForCredit(deps, depositTxId))) {
		Object.assign(record, {
			stage: 'needs-attention',
			attention: `Deposit sent (${depositTxId.slice(0, 8)}…) but Magi hasn't credited it yet. Check again in a minute; then swap or withdraw.`,
			updatedAt: (deps.now ?? Date.now)(),
		})
		await deps.save({ ...record })
		return record
	}
	Object.assign(record, { stage: 'deposit-credited', updatedAt: (deps.now ?? Date.now)() })
	await deps.save({ ...record })

	// Step 2.
	return runSwapStep(deps, record, quote.ops.swap)
}

/** Retry the swap for funds already in the user's Magi balance. Builds a
 *  fresh swap op (new minimum out) and runs only step 2. */
export async function retryMagiSwap(record: MagiSwapRecord, deps: MagiExecDeps): Promise<MagiSwapRecord> {
	const capability = await deps.getCapability()
	const route = findMagiRoute(record.from, record.to)!
	const availability = magiRouteAvailability(route, capability)
	if (!availability.available) throw new Error(availability.reason)
	const withReferral = await deps.referralActive()
	const build = await deps.sdk.buildQuickSwap({
		username: record.username, assetIn: record.from,
		amountIn: deps.sdk.coinAmount(record.amountIn, record.from),
		assetOut: record.to, recipient: record.recipient, slippageBps: MAGI_SLIPPAGE_BPS,
		withReferral,
	})
	const { swap } = splitMagiOps(build.ops, record.username)
	assertSwapReferral(swap, withReferral)
	const next = { ...record, minOut: fromRaw(build.preview.minAmountOut, record.to) }
	return runSwapStep(deps, next, swap)
}

/** Withdraw from the user's Magi balance back to their Hive account. */
export async function withdrawFromMagi(params: { username: string; asset: MagiHiveAsset; amount?: bigint }, deps: Pick<MagiExecDeps, 'ledger' | 'signAndBroadcastOps' | 'getCapability'>): Promise<{ txid: string; amount: bigint }> {
	if ((await deps.getCapability()) !== 'supported') {
		throw new Error('Withdrawing from Magi needs KeepKey firmware with Hive operation signing (HiveSignOperations).')
	}
	const balance = await deps.ledger.getBalance(params.username)
	const available = params.asset === 'HBD' ? balance.hbd : balance.hive
	const amount = params.amount ?? available
	if (amount <= 0n) throw new Error(`No ${params.asset} in your Magi balance`)
	if (amount > available) throw new Error(`Only ${formatMilli(available)} ${params.asset} in your Magi balance`)
	const op = deps.ledger.buildWithdraw({ username: params.username, asset: params.asset, amount })
	const { txid } = await deps.signAndBroadcastOps([op])
	return { txid, amount }
}

// ── BTC in ───────────────────────────────────────────────────────────

const depositAddressCache = new Map<string, string>()
export function clearMagiDepositAddressCache() { depositAddressCache.clear() }

/**
 * Magi's BTC deposit address for (user, asset). One fixed address per pair,
 * so it is cached. Call only when the user continues: it creates a mapping.
 * TODO(magi): ask the Magi team for the minimum deposit and confirmation
 * count; until then the UI says "market price after Bitcoin confirmations;
 * send a small amount first" and invents no minimum.
 */
export async function getMagiBtcDeposit(sdk: Pick<MagiSdk, 'getBtcDepositAddress'>, username: string, assetOut: MagiHiveAsset): Promise<{ address: string }> {
	if (!/^[a-z][a-z0-9.-]{2,15}$/.test(username)) throw new Error('Invalid Hive account name')
	const key = `${username}:${assetOut}`
	const hit = depositAddressCache.get(key)
	if (hit) return { address: hit }
	const { address } = await sdk.getBtcDepositAddress({ recipient: `hive:${username}`, assetOut, destinationChain: 'HIVE' })
	if (!isValidBtcAddress(address)) throw new Error('Magi returned an invalid Bitcoin deposit address')
	depositAddressCache.set(key, address)
	return { address }
}
