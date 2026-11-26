/**
 * Magi (VSC) swaps: the one place for the referral, slippage, routes and the
 * gates that decide whether a route can run on this KeepKey.
 *
 * Six routes between HIVE, HBD and BTC:
 *  - HIVE/HBD out: Magi returns [deposit transfer, swap custom_json]. The
 *    KeepKey signs them as two separate transactions (see bun/swap/magi.ts):
 *    the transfer on the dedicated HiveSignTx path, the custom_json through
 *    HiveSignOperations. That second message only exists on some firmware
 *    builds, so these routes are gated on a capability, never on a version.
 *  - BTC in: Magi's mapping bot gives a deposit address; the vault sends BTC
 *    to it like any other plain deposit. No Hive signing involved.
 *
 * Pure module: no network, safe for the webview and tests.
 */

/** Referral for every Magi swap. Change it here only.
 *  The SDK applies it only when the output leaves Hive (BTC): HIVE<->HBD swaps
 *  carry no referral (crosschain-core referralQualifies). */
export const MAGI_REFERRAL = { beneficiary: 'hive:sopadevs', bps: 100 } as const

/** Default slippage tolerance, in basis points (0.5%, as in the Skate Wallet). */
export const MAGI_SLIPPAGE_BPS = 50

export type MagiAsset = 'HIVE' | 'HBD' | 'BTC'
export const MAGI_ASSETS: readonly MagiAsset[] = ['HIVE', 'HBD', 'BTC']

/** How a route executes on the KeepKey. */
export type MagiRouteKind = 'hive-ops' | 'btc-deposit'

export interface MagiRoute {
	from: MagiAsset
	to: MagiAsset
	kind: MagiRouteKind
}

/** The six supported routes. */
export const MAGI_ROUTES: readonly MagiRoute[] = [
	{ from: 'HIVE', to: 'HBD', kind: 'hive-ops' },
	{ from: 'HBD', to: 'HIVE', kind: 'hive-ops' },
	{ from: 'HIVE', to: 'BTC', kind: 'hive-ops' },
	{ from: 'HBD', to: 'BTC', kind: 'hive-ops' },
	{ from: 'BTC', to: 'HIVE', kind: 'btc-deposit' },
	{ from: 'BTC', to: 'HBD', kind: 'btc-deposit' },
]

export function findMagiRoute(from: string, to: string): MagiRoute | null {
	return MAGI_ROUTES.find(r => r.from === from && r.to === to) ?? null
}

/** Whether Magi charges the referral on this route (mirrors the SDK rule:
 *  only when the swap leaves Hive). Used for display only. */
export function magiReferralApplies(to: MagiAsset): boolean {
	return to === 'BTC'
}

/** Mainnet BTC address: bech32/bech32m, P2PKH or P2SH. Rejects extended keys.
 *  Shape check only; the send path still validates the address fully. */
const BTC_ADDRESS_RE = /^(bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/
export function isValidBtcAddress(address: string | undefined | null): boolean {
	return !!address && BTC_ADDRESS_RE.test(address.trim())
}

// ── HiveSignOperations capability ────────────────────────────────────
//
// Measured on device (2026-11-25): release 7.16.0 and 7.17.0-rc8 (a6ee7dd)
// do NOT have HiveSignOperations; the 7.17.0 alpha 378cf30 does. The feature
// lives on one line of the fork, so "version >= X" gives false positives.
// The source of truth is a promptless probe (bun/hive-ops-capability.ts);
// this allowlist only short-circuits builds we have measured.

export type HiveOpsCapability = 'supported' | 'unsupported' | 'unknown'

/** Device-reported firmware hash → capability. Each build is listed twice:
 *  sha256 of the whole .bin, and of the .bin without its 256-byte KPKY
 *  header (`tail -c +257`), since builds have reported either form. */
export const HIVE_OPS_FIRMWARE_HASHES: Readonly<Record<string, Exclude<HiveOpsCapability, 'unknown'>>> = {
	// v7.17.0 alpha 378cf30 (full-firmware.keepkey.bin)
	d3481482865628a9ae0c347c1cad45328cdc8770e2985c34d01072e3e5291fda: 'supported',
	'747eb286305b87d85946be3fa4ace85d957a967e1dd961edce48efa59864b72e': 'supported',
	// v7.17.0-rc8 a6ee7dd (full-firmware.keepkey.bin)
	'0e507dff586827a48e856192b06dbc9de0521da2af31b97b2e105e449c8e7cab': 'unsupported',
	'02e7af4af05706b234956441ff77e93707b630026e9e263e5a0d1f6a03952cf9': 'unsupported',
}

export function knownHiveOpsCapability(firmwareHash: string | undefined | null): HiveOpsCapability {
	if (!firmwareHash) return 'unknown'
	return HIVE_OPS_FIRMWARE_HASHES[firmwareHash.toLowerCase()] ?? 'unknown'
}

export interface MagiAvailability {
	available: boolean
	/** Plain-English reason shown on the route when unavailable. */
	reason?: string
}

/**
 * Whether a route can run on this device. BTC-in routes never need Hive
 * signing. Hive-out routes need HiveSignOperations for the second step, and
 * the first step (the deposit) must not be signed unless the second can be:
 * so 'unknown' blocks too, with a reason that says how to resolve it.
 */
export function magiRouteAvailability(route: MagiRoute, capability: HiveOpsCapability): MagiAvailability {
	if (route.kind === 'btc-deposit') return { available: true }
	if (capability === 'supported') return { available: true }
	if (capability === 'unsupported') {
		return { available: false, reason: 'Needs KeepKey firmware with Hive operation signing (HiveSignOperations). This firmware only signs plain Hive transfers.' }
	}
	return { available: false, reason: 'Unlock your KeepKey so Desktop can check whether its firmware signs Hive operations.' }
}

// ── Shapes shared with the webview ──────────────────────────────────

export type MagiSwapStage =
	| 'signing-deposit'      // device prompt 1
	| 'deposit-sent'         // broadcast, waiting for Magi's ledger
	| 'deposit-credited'     // in the user's Magi balance; swap not sent yet
	| 'signing-swap'         // device prompt 2
	| 'swap-sent'            // swap broadcast
	| 'complete'
	| 'needs-attention'      // funds in the user's Magi balance; retry or withdraw
	| 'cancelled'            // deposit not signed or not sent; nothing moved

export interface MagiSwapRecord {
	id: string
	username: string
	from: 'HIVE' | 'HBD'
	to: MagiAsset
	amountIn: string
	minOut: string
	recipient: string
	stage: MagiSwapStage
	depositTxId?: string
	swapTxId?: string
	/** Plain-English state for the user when stage is needs-attention. */
	attention?: string
	updatedAt: number
}

/** A quote as the webview sees it: no operations, just what to show. */
export interface MagiQuoteView {
	quoteId: string
	provider: 'Magi'
	route: MagiRoute
	username: string
	amountIn: string
	expectedOut: string
	minOut: string
	referralBps: number
	hops: 1 | 2
	recipient: string
	blockReason?: string
	simDeferred: boolean
}
