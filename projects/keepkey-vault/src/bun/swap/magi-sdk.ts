/**
 * Real implementations of the narrow interfaces in swap/magi.ts, backed by
 * @vsc.eco/crosschain-sdk 0.0.3 and Hive nodes. Loaded lazily: the SDK is
 * ESM and only needed when a Magi route is used.
 *
 * SDK pitfalls (Skatehive Coder / SDK source):
 *  - The pool provider needs MAINNET_CONFIG.indexerUrl, or every quote is 0.
 *  - A referral without a price provider throws.
 *  - client.getBalance reads the Hive L1 account (liquid), not Magi's ledger.
 */
import { MAGI_REFERRAL } from '../../shared/magi-config'
import { hiveRpc } from '../txbuilder/hive-broadcast'
import type { HiveOpTuple } from '../txbuilder/hive-ops'
import { createGraphqlMagiLedger, type MagiLedger } from './magi-ledger'
import type { HiveRcReader, MagiSdk } from './magi'

type LoadedMagi = { sdk: MagiSdk; gqlUrls: readonly string[] }
let sdkPromise: Promise<LoadedMagi> | null = null

export function loadMagiSdk(): Promise<LoadedMagi> {
	if (sdkPromise) return sdkPromise
	const p: Promise<LoadedMagi> = (async () => {
		const m = await import('@vsc.eco/crosschain-sdk')
		const core = await import('@vsc.eco/crosschain-core')
		const pools = m.createDefaultPoolProvider(undefined, m.MAINNET_CONFIG.indexerUrl)
		const client = m.createMagi({
			config: { ...m.MAINNET_CONFIG, referral: { ...MAGI_REFERRAL } },
			pools,
			prices: m.createPoolPriceProvider(pools),
		})
		// Same pools, no referral: used while the beneficiary account is missing.
		const plainClient = m.createMagi({ config: { ...m.MAINNET_CONFIG, referral: null }, pools })
		const sdk: MagiSdk = {
			buildQuickSwap: ({ withReferral, ...input }) => (withReferral ? client : plainClient).buildQuickSwap(input as any) as any,
			coinAmount: (decimal, asset) => m.CoinAmount.fromDecimal(decimal, asset),
			getLiquidBalance: (username, asset) => client.getBalance(username, asset),
			// The SDK adds the "hive:" prefix itself (getAccountRc / sim required_auths).
			checkSwapRc: (username, swapOp) => m.checkSwapRc(client.config, { username, call: m.simCallFromSwapOp(swapOp) }) as any,
			requiredRc: (swapOp) => BigInt(m.simCallFromSwapOp(swapOp).rc_limit || 10_000),
			withSwapOpRcLimit: (swapOp, rcLimit) => core.withSwapOpRcLimit(swapOp, rcLimit) as unknown as HiveOpTuple,
			getBtcDepositAddress: (req) => client.getBtcDepositAddress(req),
		}
		const urls = (m.MAINNET_CONFIG.gqlUrls ?? [m.MAINNET_CONFIG.gqlUrl]).filter((u): u is string => !!u)
		return { sdk, gqlUrls: urls }
	})()
	sdkPromise = p
	p.catch(() => { if (sdkPromise === p) sdkPromise = null })
	return p
}

export async function loadMagiLedger(): Promise<MagiLedger> {
	const { gqlUrls } = await loadMagiSdk()
	return createGraphqlMagiLedger({ gqlUrls })
}

/** Hive RC regenerates linearly over 5 days. */
const RC_REGEN_SECONDS = 432_000n

/** Current mana from rc_api, with regeneration since the last update applied. */
export function regeneratedMana(rcAccount: { rc_manabar: { current_mana: string | number; last_update_time: number }; max_rc: string | number }, nowSeconds: number): bigint {
	const max = BigInt(rcAccount.max_rc)
	const current = BigInt(rcAccount.rc_manabar.current_mana)
	const elapsed = BigInt(Math.max(0, nowSeconds - rcAccount.rc_manabar.last_update_time))
	const regen = (max * elapsed) / RC_REGEN_SECONDS
	return current + regen > max ? max : current + regen
}

export const hiveRcReader: HiveRcReader = {
	async currentMana(username) {
		const res: any = await hiveRpc('rc_api.find_rc_accounts', { accounts: [username] })
		const acct = res?.rc_accounts?.[0]
		if (!acct) throw new Error(`Hive account @${username} not found`)
		return { current: regeneratedMana(acct, Math.floor(Date.now() / 1000)), max: BigInt(acct.max_rc) }
	},
}

// ── Referral beneficiary gate ────────────────────────────────────────
//
// Magi credits the referral to the beneficiary by name on its ledger. While
// that Hive account does not exist, a fee would sit under a name anyone could
// register and then withdraw. So the referral is omitted until the account is
// seen on chain. A found account is cached for the process; a missing one for
// MISSING_TTL_MS; a lookup error is not cached and turns the referral off.

const MISSING_TTL_MS = 10 * 60_000

export function createHiveAccountExists(opts: {
	rpc?: (method: string, params: unknown) => Promise<unknown>
	now?: () => number
	missingTtlMs?: number
} = {}) {
	const rpc = opts.rpc ?? ((method, params) => hiveRpc(method, params))
	const now = opts.now ?? Date.now
	const ttl = opts.missingTtlMs ?? MISSING_TTL_MS
	const cache = new Map<string, { exists: boolean; at: number }>()
	return async function hiveAccountExists(name: string): Promise<boolean> {
		const hit = cache.get(name)
		if (hit && (hit.exists || now() - hit.at < ttl)) return hit.exists
		try {
			const res = await rpc('condenser_api.get_accounts', [[name]])
			const exists = Array.isArray(res) && res.some((a: any) => a?.name === name)
			cache.set(name, { exists, at: now() })
			return exists
		} catch {
			return false
		}
	}
}

const accountExists = createHiveAccountExists()

/** Whether swaps may carry MAGI_REFERRAL right now. */
export function magiReferralActive(): Promise<boolean> {
	return accountExists(MAGI_REFERRAL.beneficiary.replace(/^hive:/, ''))
}
