import { describe, expect, test, beforeEach } from 'bun:test'
import { createHash } from 'node:crypto'
import {
	MAGI_REFERRAL, MAGI_ROUTES, findMagiRoute, isValidBtcAddress, magiRouteAvailability,
	knownHiveOpsCapability, magiReferralApplies,
} from '../src/shared/magi-config'
import {
	truncateAmount, toRaw, fromRaw, splitMagiOps, readSwapPayload, quoteMagiHiveOut,
	isPreDepositSimArtifact, executeMagiHiveOut, retryMagiSwap, withdrawFromMagi,
	getMagiBtcDeposit, clearMagiDepositAddressCache, HIVE_RC_PER_TX_ESTIMATE, assertSwapReferral,
	type MagiSdk, type MagiSwapRecord, type MagiExecDeps,
} from '../src/bun/swap/magi'
import { buildMagiWithdrawOp, createGraphqlMagiLedger, formatMilli, type MagiLedger } from '../src/bun/swap/magi-ledger'
import { classifyHiveOpsProbe, getHiveOpsCapability, probeIsPromptless, clearHiveOpsCapabilityCache } from '../src/bun/hive-ops-capability'
import { assembleSignedHiveTx, hiveTxId, hiveRpc, broadcastSignedHiveTx, HiveRpcError } from '../src/bun/txbuilder/hive-broadcast'
import { HIVE_MAINNET_CHAIN_ID, type HiveOpTuple } from '../src/bun/txbuilder/hive-ops'
import { regeneratedMana, createHiveAccountExists } from '../src/bun/swap/magi-sdk'

const USER = 'vladtest'
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

/** Ops shaped like crosschain-sdk 0.0.3 buildQuickSwap output. */
function magiOps(params: { amount?: string; asset?: 'HIVE' | 'HBD'; assetOut?: string; recipient?: string; from?: string; rcLimit?: number; referral?: { beneficiary: string; ref_bps: number } } = {}): HiveOpTuple[] {
	const from = params.from ?? USER
	const asset = params.asset ?? 'HIVE'
	return [
		['transfer', { from, to: 'vsc.gateway', amount: `${params.amount ?? '100.000'} ${asset}`, memo: `to=${from}` }],
		['custom_json', {
			required_auths: [from], required_posting_auths: [], id: 'vsc.call',
			json: JSON.stringify({
				net_id: 'vsc-mainnet', caller: `hive:${from}`, contract_id: 'vsc1Brvi4YZHLkocYNAFd7Gf1JpsPjzNnv4i45', action: 'execute',
				payload: JSON.stringify({ type: 'swap', version: '1.0.0', asset_in: asset.toLowerCase(), asset_out: (params.assetOut ?? 'BTC').toLowerCase(), amount_in: '100000', min_amount_out: '6096', recipient: params.recipient ?? BTC, ...params.referral }),
				rc_limit: params.rcLimit ?? 10000,
				intents: [{ type: 'transfer.allow', args: { limit: params.amount ?? '100.000', token: asset.toLowerCase() } }],
			}),
		}],
	]
}

function withRcLimit(op: HiveOpTuple, rcLimit: number): HiveOpTuple {
	const call = JSON.parse(op[1].json)
	return ['custom_json', { ...op[1], json: JSON.stringify({ ...call, rc_limit: rcLimit }) }]
}
const rcLimitOf = (op: HiveOpTuple) => JSON.parse(op[1].json).rc_limit

function fakeSdk(over: Partial<{ expectedOutput: bigint; minAmountOut: bigint; referralApplied: boolean; liquid: bigint | null; rc: any; ops: HiveOpTuple[]; referral: { beneficiary: string; ref_bps: number } }> = {}) {
	const calls: any[] = []
	const sdk: MagiSdk = {
		async buildQuickSwap(input) {
			calls.push(input)
			// Like crosschain-core: the referral goes into the payload only when configured and qualifying (BTC out).
			const applied = over.referralApplied ?? (input.withReferral && input.assetOut === 'BTC')
			const referral = over.referral ?? (applied ? { beneficiary: MAGI_REFERRAL.beneficiary, ref_bps: MAGI_REFERRAL.bps } : undefined)
			return {
				ops: over.ops ?? magiOps({ asset: input.assetIn, assetOut: input.assetOut, recipient: input.recipient, referral }),
				preview: { expectedOutput: over.expectedOutput ?? 6127n, minAmountOut: over.minAmountOut ?? 6096n, totalFee: 10n, hops: 1 },
				referralApplied: applied,
			}
		},
		coinAmount: (d) => d,
		getLiquidBalance: async () => (over.liquid === undefined ? 250_000n : over.liquid),
		checkSwapRc: async () => over.rc ?? { simOk: true, rcUsed: 7000n, rcAvailable: 20_000n, sufficient: true, broadcastRcLimit: 9000 },
		requiredRc: (op) => BigInt(rcLimitOf(op) || 10_000),
		withSwapOpRcLimit: withRcLimit,
		getBtcDepositAddress: async () => ({ address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }),
	}
	return { sdk, calls }
}
const richRc = { currentMana: async () => ({ current: HIVE_RC_PER_TX_ESTIMATE * 10n, max: HIVE_RC_PER_TX_ESTIMATE * 20n }) }

describe('magi config', () => {
	test('six routes, Hive-out signed on device, BTC-in as a deposit', () => {
		expect(MAGI_ROUTES).toHaveLength(6)
		expect(findMagiRoute('HIVE', 'HBD')?.kind).toBe('hive-ops')
		expect(findMagiRoute('HBD', 'BTC')?.kind).toBe('hive-ops')
		expect(findMagiRoute('BTC', 'HBD')?.kind).toBe('btc-deposit')
		expect(findMagiRoute('BTC', 'BTC')).toBeNull()
	})
	test('one referral constant, charged only when the swap leaves Hive', () => {
		expect(MAGI_REFERRAL).toEqual({ beneficiary: 'hive:sopadevs', bps: 100 })
		expect(magiReferralApplies('BTC')).toBe(true)
		expect(magiReferralApplies('HBD')).toBe(false)
	})
	test('accepts Bitcoin addresses and rejects extended public keys', () => {
		expect(isValidBtcAddress(BTC)).toBe(true)
		expect(isValidBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true)
		expect(isValidBtcAddress('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs')).toBe(false)
		expect(isValidBtcAddress('')).toBe(false)
	})
	test('gate: BTC-in always open; Hive-out needs HiveSignOperations, and unknown blocks', () => {
		const out = findMagiRoute('HIVE', 'BTC')!, inn = findMagiRoute('BTC', 'HIVE')!
		expect(magiRouteAvailability(inn, 'unsupported').available).toBe(true)
		expect(magiRouteAvailability(out, 'supported').available).toBe(true)
		expect(magiRouteAvailability(out, 'unsupported')).toMatchObject({ available: false, reason: expect.stringContaining('HiveSignOperations') })
		expect(magiRouteAvailability(out, 'unknown')).toMatchObject({ available: false, reason: expect.stringContaining('Unlock') })
	})
	test('measured firmware hashes answer without a probe', () => {
		expect(knownHiveOpsCapability('D3481482865628A9AE0C347C1CAD45328CDC8770E2985C34D01072E3E5291FDA')).toBe('supported')
		expect(knownHiveOpsCapability('0e507dff586827a48e856192b06dbc9de0521da2af31b97b2e105e449c8e7cab')).toBe('unsupported')
		expect(knownHiveOpsCapability('747eb286305b87d85946be3fa4ace85d957a967e1dd961edce48efa59864b72e')).toBe('supported') // without KPKY header
		expect(knownHiveOpsCapability('02e7af4af05706b234956441ff77e93707b630026e9e263e5a0d1f6a03952cf9')).toBe('unsupported')
		expect(knownHiveOpsCapability(undefined)).toBe('unknown')
	})
})

describe('amounts', () => {
	test('truncate, never round up', () => {
		expect(truncateAmount('1.23456', 'HIVE')).toBe('1.234')
		expect(truncateAmount('2', 'HBD')).toBe('2.000')
		expect(toRaw('1.2349', 'HIVE')).toBe(1234n)
		expect(fromRaw(6127n, 'BTC')).toBe('0.00006127')
		expect(() => truncateAmount('1e3', 'HIVE')).toThrow()
	})
})

describe('splitMagiOps', () => {
	test('splits the deposit transfer from the active vsc.call swap', () => {
		const { deposit, swap } = splitMagiOps(magiOps(), USER)
		expect(deposit[0]).toBe('transfer')
		expect(swap[1].id).toBe('vsc.call')
		expect(readSwapPayload(swap)).toMatchObject({ type: 'swap', recipient: BTC })
	})
	test('refuses anything that is not exactly [transfer to the gateway, active vsc.call by the same user]', () => {
		expect(() => splitMagiOps(magiOps().slice(0, 1), USER)).toThrow()
		expect(() => splitMagiOps(magiOps({ from: 'mallory' }), USER)).toThrow(/sender|same account/)
		const wrongTo = magiOps(); wrongTo[0] = ['transfer', { ...wrongTo[0]![1], to: 'mallory' }]
		expect(() => splitMagiOps(wrongTo, USER)).toThrow(/recipient/)
		const posting = magiOps(); posting[1] = ['custom_json', { ...posting[1]![1], required_auths: [], required_posting_auths: [USER] }]
		expect(() => splitMagiOps(posting, USER)).toThrow()
		const otherId = magiOps(); otherId[1] = ['custom_json', { ...otherId[1]![1], id: 'vsc.withdraw' }]
		expect(() => splitMagiOps(otherId, USER)).toThrow(/id/)
	})
})

describe('quoteMagiHiveOut', () => {
	const base = { hiveRc: richRc, capability: 'supported' as const, username: USER, referralActive: true }

	test('quotes HIVE to BTC with the referral and tightens rc_limit from the simulation', async () => {
		const { sdk, calls } = fakeSdk()
		const q = await quoteMagiHiveOut({ ...base, sdk, from: 'HIVE', to: 'BTC', amount: '100', btcAddress: BTC })
		expect(calls[0]).toMatchObject({ username: USER, assetIn: 'HIVE', assetOut: 'BTC', recipient: BTC, slippageBps: 50 })
		expect(q).toMatchObject({ provider: 'Magi', expectedOut: '0.00006127', minOut: '0.00006096', referralBps: 100, simDeferred: false })
		expect(q.blockReason).toBeUndefined()
		expect(rcLimitOf(q.ops.swap)).toBe(9000)
	})
	test('HBD to HIVE: recipient is the user, no referral', async () => {
		const { sdk, calls } = fakeSdk({ expectedOutput: 4_000n, minAmountOut: 3_980n })
		const q = await quoteMagiHiveOut({ ...base, sdk, from: 'HBD', to: 'HIVE', amount: '1' })
		expect(calls[0]).toMatchObject({ assetIn: 'HBD', assetOut: 'HIVE', recipient: `hive:${USER}` })
		expect(q).toMatchObject({ referralBps: 0, expectedOut: '4.000', minOut: '3.980' })
	})
	test('keeps the quote visible but blocks it: firmware, liquid balance, Hive RC, Magi RC', async () => {
		const p = { ...base, from: 'HIVE' as const, to: 'BTC' as const, amount: '100', btcAddress: BTC }
		expect((await quoteMagiHiveOut({ ...p, sdk: fakeSdk().sdk, capability: 'unsupported' })).blockReason).toMatch(/HiveSignOperations/)
		expect((await quoteMagiHiveOut({ ...p, sdk: fakeSdk({ liquid: 50_000n }).sdk })).blockReason).toMatch(/Not enough liquid HIVE/)
		expect((await quoteMagiHiveOut({ ...p, sdk: fakeSdk().sdk, hiveRc: { currentMana: async () => ({ current: HIVE_RC_PER_TX_ESTIMATE, max: 120n * HIVE_RC_PER_TX_ESTIMATE }) } })).blockReason)
			.toMatch(/about 2\.0 billion RC short\. Power up some HIVE, or wait about 1 h/)
		const lowMagiRc = fakeSdk({ rc: { simOk: true, rcUsed: 1n, rcAvailable: 4_000n, sufficient: false, broadcastRcLimit: 9000 } })
		expect((await quoteMagiHiveOut({ ...p, sdk: lowMagiRc.sdk })).blockReason).toMatch(/Magi Resource Credits/)
	})
	test('ignores the expected pre-deposit simulation failures but blocks a real one', async () => {
		const p = { ...base, from: 'HBD' as const, to: 'BTC' as const, amount: '1', btcAddress: BTC }
		for (const rc of [
			{ simOk: false, err: 'ledger_error', errMsg: 'insufficient balance', rcAvailable: 20_000n },
			{ simOk: false, err: 'gas_limit_hit', errMsg: 'cost limit exceeded', rcAvailable: 20_000n },
		]) {
			const q = await quoteMagiHiveOut({ ...p, sdk: fakeSdk({ rc }).sdk })
			expect(q.blockReason).toBeUndefined()
			expect(q.simDeferred).toBe(true)
			expect(rcLimitOf(q.ops.swap)).toBe(10000) // untouched until the real sim
		}
		const real = await quoteMagiHiveOut({ ...p, sdk: fakeSdk({ rc: { simOk: false, err: 'contract_error', errMsg: 'min out', rcAvailable: 20_000n } }).sdk })
		expect(real.blockReason).toMatch(/Magi cannot run this swap/)
		expect(isPreDepositSimArtifact({ simOk: true })).toBe(false)
	})
	test('refuses without a Bitcoin address, without liquidity, or on a BTC-in pair', async () => {
		const { sdk } = fakeSdk()
		await expect(quoteMagiHiveOut({ ...base, sdk, from: 'HIVE', to: 'BTC', amount: '1', btcAddress: 'xpub123' })).rejects.toThrow(/valid Bitcoin address/)
		await expect(quoteMagiHiveOut({ ...base, sdk: fakeSdk({ expectedOutput: 0n }).sdk, from: 'HIVE', to: 'BTC', amount: '1', btcAddress: BTC })).rejects.toThrow(/No route/)
		await expect(quoteMagiHiveOut({ ...base, sdk, from: 'HIVE', to: 'HIVE' as any, amount: '1' })).rejects.toThrow(/no HIVE → HIVE route/)
	})
})

// ── Execution ───────────────────────────────────────────────────────

function execHarness(over: Partial<MagiExecDeps> & { sdkOver?: Parameters<typeof fakeSdk>[0]; credited?: boolean } = {}) {
	const saved: MagiSwapRecord[] = []
	const device: string[] = []
	let t = 0
	const ledger: MagiLedger = {
		getBalance: async () => ({ hive: 100_000n, hbd: 0n }),
		isDepositCredited: async () => over.credited ?? true,
		listWithdrawals: async () => [],
		buildWithdraw: buildMagiWithdrawOp,
	}
	const deps: MagiExecDeps = {
		signAndBroadcastDeposit: async (op) => { device.push(`HiveSignTx:${op[0]}`); return { txid: 'a'.repeat(40) } },
		signAndBroadcastOps: async (ops) => { device.push(`HiveSignOperations:${ops.map(o => o[0] === 'custom_json' ? o[1].id : o[0]).join(',')}`); return { txid: 'b'.repeat(40) } },
		getCapability: async () => 'supported',
		sdk: fakeSdk(over.sdkOver).sdk,
		hiveRc: richRc,
		ledger,
		save: (r) => { saved.push(r) },
		referralActive: async () => true,
		sleep: async (ms) => { t += ms },
		now: () => t,
		creditTimeoutMs: 10_000,
		...over,
	}
	return { deps, saved, device }
}

async function quote(sdkOver?: Parameters<typeof fakeSdk>[0]) {
	return quoteMagiHiveOut({ sdk: fakeSdk(sdkOver).sdk, hiveRc: richRc, capability: 'supported', username: USER, from: 'HIVE', to: 'BTC', amount: '100', btcAddress: BTC, referralActive: true })
}

describe('executeMagiHiveOut: two device transactions', () => {
	test('deposit on HiveSignTx, then the swap on HiveSignOperations after the credit', async () => {
		const { deps, saved, device } = execHarness()
		const r = await executeMagiHiveOut(await quote(), deps, 'swap-1')
		expect(device).toEqual(['HiveSignTx:transfer', 'HiveSignOperations:vsc.call'])
		expect(r).toMatchObject({ stage: 'swap-sent', depositTxId: 'a'.repeat(40), swapTxId: 'b'.repeat(40) })
		expect(saved.map(s => s.stage)).toEqual(['signing-deposit', 'deposit-sent', 'deposit-credited', 'signing-swap', 'swap-sent'])
	})
	test('nothing is signed when the firmware cannot do step 2', async () => {
		for (const cap of ['unsupported', 'unknown'] as const) {
			const { deps, device } = execHarness({ getCapability: async () => cap })
			await expect(executeMagiHiveOut(await quote(), deps, 'x')).rejects.toThrow()
			expect(device).toEqual([])
		}
	})
	test('nothing is signed when Hive RC cannot cover both transactions', async () => {
		const { deps, device } = execHarness({ hiveRc: { currentMana: async () => ({ current: 1n, max: 1n }) } })
		await expect(executeMagiHiveOut(await quote(), deps, 'x')).rejects.toThrow(/Resource Credits/)
		expect(device).toEqual([])
	})
	test('a blocked quote never executes', async () => {
		const { deps, device } = execHarness()
		await expect(executeMagiHiveOut({ ...(await quote()), blockReason: 'nope' }, deps, 'x')).rejects.toThrow('nope')
		expect(device).toEqual([])
	})
	test('deposit cancelled on device: rethrows, nothing moved', async () => {
		const { deps, saved } = execHarness({ signAndBroadcastDeposit: async () => { throw new Error('Action cancelled') } })
		await expect(executeMagiHiveOut(await quote(), deps, 'x')).rejects.toThrow('Action cancelled')
		expect(saved.at(-1)?.stage).toBe('cancelled')
	})
	test('deposit never credited: needs attention, swap not signed', async () => {
		const { deps, device, saved } = execHarness({ credited: false })
		const r = await executeMagiHiveOut(await quote(), deps, 'x')
		expect(r.stage).toBe('needs-attention')
		expect(r.attention).toMatch(/hasn't credited/)
		expect(device).toEqual(['HiveSignTx:transfer'])
		expect(saved.at(-1)?.stage).toBe('needs-attention')
	})
	test('swap simulation fails after the credit: funds are in the Magi balance, user told', async () => {
		const { deps, device } = execHarness({ sdkOver: { rc: { simOk: false, err: 'contract_error', errMsg: 'min out not met', rcAvailable: 20_000n } } })
		const r = await executeMagiHiveOut(await quote(), deps, 'x')
		expect(r.stage).toBe('needs-attention')
		expect(r.attention).toMatch(/in your Magi balance.*withdraw/)
		expect(device).toEqual(['HiveSignTx:transfer'])
	})
	test('swap rejected on the device: needs attention, not a silent stop', async () => {
		const { deps } = execHarness({ signAndBroadcastOps: async () => { throw new Error('Action cancelled') } })
		const r = await executeMagiHiveOut(await quote(), deps, 'x')
		expect(r).toMatchObject({ stage: 'needs-attention', attention: expect.stringContaining('was not sent') })
	})
	test('the swap is signed with the rc_limit from the post-deposit simulation', async () => {
		let signed: HiveOpTuple[] = []
		const { deps } = execHarness({
			sdkOver: { rc: { simOk: true, rcUsed: 100n, rcAvailable: 20_000n, sufficient: true, broadcastRcLimit: 125 } },
			signAndBroadcastOps: async (ops) => { signed = ops; return { txid: 'c'.repeat(40) } },
		})
		await executeMagiHiveOut(await quote(), deps, 'x')
		expect(rcLimitOf(signed[0]!)).toBe(125)
	})
})

describe('recovery', () => {
	const stuck: MagiSwapRecord = { id: 's', username: USER, from: 'HIVE', to: 'BTC', amountIn: '100.000', minOut: '0.00006096', recipient: BTC, stage: 'needs-attention', depositTxId: 'a'.repeat(40), updatedAt: 0 }

	test('retry runs only step 2 with a fresh swap op', async () => {
		const { deps, device } = execHarness()
		const r = await retryMagiSwap(stuck, deps)
		expect(device).toEqual(['HiveSignOperations:vsc.call'])
		expect(r.stage).toBe('swap-sent')
	})
	test('withdraw builds the confirmed vsc.withdraw op, active auth, lowercase asset', () => {
		expect(buildMagiWithdrawOp({ username: USER, asset: 'HBD', amount: 87n })).toEqual(['custom_json', {
			required_auths: [USER], required_posting_auths: [], id: 'vsc.withdraw',
			json: JSON.stringify({ from: `hive:${USER}`, to: `hive:${USER}`, amount: '0.087', asset: 'hbd', net_id: 'vsc-mainnet' }),
		}])
		expect(() => buildMagiWithdrawOp({ username: USER, asset: 'HIVE', amount: 0n })).toThrow()
	})
	test('withdraw defaults to the whole balance and refuses more than is there', async () => {
		const { deps, device } = execHarness()
		expect(await withdrawFromMagi({ username: USER, asset: 'HIVE' }, deps)).toMatchObject({ amount: 100_000n })
		expect(device).toEqual(['HiveSignOperations:vsc.withdraw'])
		await expect(withdrawFromMagi({ username: USER, asset: 'HIVE', amount: 100_001n }, deps)).rejects.toThrow(/Only 100.000 HIVE/)
		await expect(withdrawFromMagi({ username: USER, asset: 'HBD' }, deps)).rejects.toThrow(/No HBD/)
	})
	test('withdraw needs HiveSignOperations too', async () => {
		const { deps } = execHarness({ getCapability: async () => 'unsupported' })
		await expect(withdrawFromMagi({ username: USER, asset: 'HIVE' }, deps)).rejects.toThrow(/HiveSignOperations/)
	})
	test('formatMilli', () => {
		expect(formatMilli(3710n)).toBe('3.710')
		expect(formatMilli(7n)).toBe('0.007')
	})
})

describe('BTC in', () => {
	beforeEach(() => clearMagiDepositAddressCache())
	test('one validated, cached address per (user, asset)', async () => {
		let n = 0
		const sdk = { getBtcDepositAddress: async (req: any) => { n++; expect(req).toEqual({ recipient: `hive:${USER}`, assetOut: 'HBD', destinationChain: 'HIVE' }); return { address: BTC } } }
		expect(await getMagiBtcDeposit(sdk, USER, 'HBD')).toEqual({ address: BTC })
		await getMagiBtcDeposit(sdk, USER, 'HBD')
		expect(n).toBe(1)
	})
	test('rejects a malformed address from the bot', async () => {
		await expect(getMagiBtcDeposit({ getBtcDepositAddress: async () => ({ address: 'nope' }) }, USER, 'HIVE')).rejects.toThrow(/invalid Bitcoin deposit address/)
	})
})

describe('HiveSignOperations capability probe', () => {
	beforeEach(() => clearHiveOpsCapabilityCache())
	const failure = (code: number, message: string) => ({ message_type: 'Failure', message_enum: 3, message: { code, message } })
	const unlocked = { deviceId: 'dev1', firmwareHash: 'f'.repeat(64), initialized: true, pinProtection: true, pinCached: true }

	test('classifies the two firmware answers, and nothing else', () => {
		expect(classifyHiveOpsProbe({ error: failure(1, 'Unknown message') })).toBe('unsupported')
		expect(classifyHiveOpsProbe({ error: failure(3, 'Missing serialized transaction') })).toBe('supported')
		expect(classifyHiveOpsProbe({ error: failure(1, 'Device busy') })).toBe('unknown')
		expect(classifyHiveOpsProbe({ error: new Error('timeout') })).toBe('unknown')
		expect(classifyHiveOpsProbe({ resolved: true })).toBe('unknown')
	})
	test('never probes when it could prompt for the PIN', () => {
		expect(probeIsPromptless(unlocked)).toBe(true)
		expect(probeIsPromptless({ ...unlocked, pinCached: false })).toBe(false)
		expect(probeIsPromptless({ ...unlocked, pinProtection: false, pinCached: false })).toBe(true)
		expect(probeIsPromptless({ ...unlocked, initialized: false })).toBe(false)
		expect(probeIsPromptless({ ...unlocked, bootloaderMode: true })).toBe(false)
	})
	test('probes with an empty payload, caches per device + firmware hash', async () => {
		const sent: any[] = []
		const wallet = { hiveSignOperations: async (m: any) => { sent.push(m); throw failure(3, 'Missing serialized transaction') } }
		expect(await getHiveOpsCapability(wallet, unlocked)).toBe('supported')
		expect(await getHiveOpsCapability(wallet, unlocked)).toBe('supported')
		expect(sent).toHaveLength(1)
		expect(sent[0].serializedTx.length).toBe(0)
		// A reflash (new hash) probes again.
		expect(await getHiveOpsCapability(wallet, { ...unlocked, firmwareHash: 'e'.repeat(64) })).toBe('supported')
		expect(sent).toHaveLength(2)
	})
	test('locked device: no probe, unknown', async () => {
		let called = false
		const wallet = { hiveSignOperations: async () => { called = true; throw failure(3, 'Missing serialized transaction') } }
		expect(await getHiveOpsCapability(wallet, { ...unlocked, pinCached: false })).toBe('unknown')
		expect(called).toBe(false)
	})
	test('allowlisted hash answers without touching the device', async () => {
		let called = false
		const wallet = { hiveSignOperations: async () => { called = true; return {} } }
		expect(await getHiveOpsCapability(wallet, { ...unlocked, firmwareHash: '0e507dff586827a48e856192b06dbc9de0521da2af31b97b2e105e449c8e7cab' })).toBe('unsupported')
		expect(called).toBe(false)
	})
})

describe('direct Hive broadcast', () => {
	const header = { refBlockNum: 1234, refBlockPrefix: 0xdeadbeef, expirationUnix: 1_790_000_000 }
	test('assembles the node JSON from the signed header', () => {
		const tx = assembleSignedHiveTx({ header, operations: [['custom_json', { id: 'x' }]], signature: 'ab'.repeat(65) })
		expect(tx).toEqual({ ref_block_num: 1234, ref_block_prefix: 0xdeadbeef, expiration: '2026-09-21T14:13:20', operations: [['custom_json', { id: 'x' }]], extensions: [], signatures: ['ab'.repeat(65)] })
		expect(() => assembleSignedHiveTx({ header, operations: [], signature: 'ab' })).toThrow(/malformed signature/)
	})
	test('txid: sha256 of the serialized tx, first 20 bytes, chain-id prefix stripped', () => {
		const body = Buffer.from('0102030405', 'hex')
		const want = createHash('sha256').update(body).digest().subarray(0, 20).toString('hex')
		expect(hiveTxId(body)).toBe(want)
		expect(hiveTxId(Buffer.concat([Buffer.from(HIVE_MAINNET_CHAIN_ID, 'hex'), body]))).toBe(want)
	})
	test('falls through nodes on network errors only; a chain error is final; duplicate = landed', async () => {
		const hits: string[] = []
		const fetchImpl = async (url: string) => {
			hits.push(url)
			if (url === 'n1') throw new Error('ECONNREFUSED')
			return new Response(JSON.stringify({ result: { ok: true } }))
		}
		expect(await hiveRpc('m', [], { nodes: ['n1', 'n2'], fetchImpl: fetchImpl as any })).toEqual({ ok: true })
		expect(hits).toEqual(['n1', 'n2'])

		const rpcErr = async () => new Response(JSON.stringify({ error: { message: 'missing required active authority' } }))
		await expect(hiveRpc('m', [], { nodes: ['n1', 'n2'], fetchImpl: rpcErr as any })).rejects.toBeInstanceOf(HiveRpcError)

		const dup = async () => new Response(JSON.stringify({ error: { message: 'Duplicate transaction check failed' } }))
		expect(await broadcastSignedHiveTx({} as any, 'f'.repeat(40), { nodes: ['n'], fetchImpl: dup as any })).toEqual({ txid: 'f'.repeat(40) })
	})
})

describe('Magi ledger (GraphQL)', () => {
	test('reads balances as milli-units and falls back across API nodes', async () => {
		const hits: string[] = []
		const fetchImpl = async (url: string, init: any) => {
			hits.push(url)
			if (url.startsWith('https://down')) throw new Error('offline')
			expect(JSON.parse(init.body).query).toContain('getAccountBalance(account:"hive:vladtest")')
			return new Response(JSON.stringify({ data: { getAccountBalance: { hbd: 3710, hive: '87', block_height: 5 } } }))
		}
		const ledger = createGraphqlMagiLedger({ gqlUrls: ['https://down', 'https://up'], fetchImpl: fetchImpl as any })
		expect(await ledger.getBalance(USER)).toEqual({ hbd: 3710n, hive: 87n, blockHeight: 5 })
		expect(hits).toEqual(['https://down/api/v1/graphql', 'https://up/api/v1/graphql'])
	})
	test('deposit credit by Hive txid; refuses injection in query values', async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ data: { findLedgerTXs: [{ id: '1' }] } }))
		const ledger = createGraphqlMagiLedger({ gqlUrls: ['https://up'], fetchImpl: fetchImpl as any })
		expect(await ledger.isDepositCredited('a'.repeat(40))).toBe(true)
		await expect(ledger.isDepositCredited('") { x }')).rejects.toThrow()
		await expect(ledger.getBalance('a"b')).rejects.toThrow()
	})
})

describe('Hive RC', () => {
	test('applies linear regeneration over 5 days, capped at max', () => {
		const acct = { rc_manabar: { current_mana: '100', last_update_time: 0 }, max_rc: '432000' }
		expect(regeneratedMana(acct, 10)).toBe(110n)
		expect(regeneratedMana(acct, 10_000_000)).toBe(432000n)
	})
})

describe('referral beneficiary gate (hive:sopadevs may not exist yet)', () => {
	const btcQuote = (sdk: MagiSdk, referralActive: boolean) =>
		quoteMagiHiveOut({ sdk, hiveRc: richRc, capability: 'supported', username: USER, from: 'HIVE', to: 'BTC', amount: '100', btcAddress: BTC, referralActive })

	test('beneficiary account missing: BTC swap is built without a referral and shows no fee', async () => {
		const { sdk, calls } = fakeSdk()
		const q = await btcQuote(sdk, false)
		expect(calls[0].withReferral).toBe(false)
		expect(q.referralBps).toBe(0)
		const payload = readSwapPayload(q.ops.swap)
		expect(payload.beneficiary).toBeUndefined()
		expect(payload.ref_bps).toBeUndefined()
	})

	test('beneficiary account exists: BTC swap carries exactly MAGI_REFERRAL', async () => {
		const { sdk, calls } = fakeSdk()
		const q = await btcQuote(sdk, true)
		expect(calls[0].withReferral).toBe(true)
		expect(q.referralBps).toBe(100)
		expect(readSwapPayload(q.ops.swap)).toMatchObject({ beneficiary: 'hive:sopadevs', ref_bps: 100 })
	})

	test('a referral the quote did not ask for, or a different beneficiary, is refused before signing', async () => {
		await expect(btcQuote(fakeSdk({ referralApplied: false, referral: { beneficiary: 'hive:sopadevs', ref_bps: 100 } }).sdk, false)).rejects.toThrow(/should be off/)
		await expect(btcQuote(fakeSdk({ referral: { beneficiary: 'hive:someoneelse', ref_bps: 100 } }).sdk, true)).rejects.toThrow(/unexpected referral/)
		await expect(btcQuote(fakeSdk({ referral: { beneficiary: 'hive:sopadevs', ref_bps: 500 } }).sdk, true)).rejects.toThrow(/unexpected referral/)
		// HIVE/HBD outputs never qualify, with or without the gate.
		expect(() => assertSwapReferral(magiOps({ assetOut: 'HBD', recipient: `hive:${USER}` })[1], true)).not.toThrow()
	})

	test('retry follows the gate too', async () => {
		const { sdk, calls } = fakeSdk()
		const { deps } = execHarness({ sdk, referralActive: async () => false })
		const stuck: MagiSwapRecord = { id: 's', username: USER, from: 'HIVE', to: 'BTC', amountIn: '100.000', minOut: '0.00006096', recipient: BTC, stage: 'needs-attention', depositTxId: 'a'.repeat(40), updatedAt: 0 }
		await retryMagiSwap(stuck, deps)
		expect(calls[0].withReferral).toBe(false)
	})

	test('account lookup: condenser get_accounts, found cached, missing re-checked after the TTL, errors turn it off uncached', async () => {
		let t = 0
		const asked: unknown[] = []
		let chain: any[] = []
		let fail = false
		const exists = createHiveAccountExists({
			now: () => t, missingTtlMs: 600_000,
			rpc: async (method, params) => { asked.push([method, params]); if (fail) throw new Error('nodes down'); return chain },
		})
		expect(await exists('sopadevs')).toBe(false)
		expect(asked[0]).toEqual(['condenser_api.get_accounts', [['sopadevs']]])
		chain = [{ name: 'sopadevs' }]
		t = 599_999
		expect(await exists('sopadevs')).toBe(false) // still within the missing TTL
		expect(asked).toHaveLength(1)
		t = 600_000
		expect(await exists('sopadevs')).toBe(true) // account created meanwhile
		fail = true
		expect(await exists('sopadevs')).toBe(true) // found is cached; no lookup
		expect(asked).toHaveLength(2)
		expect(await exists('other')).toBe(false) // lookup error: off
		fail = false
		chain = [{ name: 'other' }]
		expect(await exists('other')).toBe(true) // error was not cached
	})
})
