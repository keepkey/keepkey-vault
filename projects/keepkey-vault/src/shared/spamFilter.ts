/**
 * Token Spam Filter — multi-tier heuristic detection.
 *
 * Detection order (first match wins):
 *  1. User override (SQLite-persisted 'visible'/'hidden') — absolute precedence
 *  2. Name/symbol contains URL or phishing keywords → CONFIRMED spam
 *  3. Symbol has suspicious characters or excessive length → CONFIRMED spam
 *  4. Known stablecoin symbol with value < $0.50 → CONFIRMED spam
 *  5. Dust airdrop: huge quantity (>1M) + near-zero unit price (<$0.0001) → CONFIRMED spam
 *  6. Value < $1 → POSSIBLE spam
 *  7. Otherwise → clean
 */

import type { TokenBalance } from './types'

export const KNOWN_STABLECOINS = [
	'USDT', 'USDC', 'DAI', 'BUSD', 'UST', 'TUSD', 'USDD', 'USDP', 'GUSD', 'PYUSD',
	'FRAX', 'LUSD', 'SUSD', 'ALUSD', 'FEI', 'MIM', 'DOLA', 'AGEUR', 'EURT', 'EURS',
]

/** Well-known legitimate token symbols — exempt from dust-airdrop heuristic */
const KNOWN_LEGIT_SYMBOLS = new Set([
	// Top tokens by market cap
	'ETH', 'BTC', 'WETH', 'WBTC', 'BNB', 'MATIC', 'POL', 'AVAX', 'SOL', 'DOT',
	'ADA', 'LINK', 'UNI', 'AAVE', 'MKR', 'CRV', 'COMP', 'SNX', 'SUSHI', 'YFI',
	'LDO', 'RPL', 'ARB', 'OP', 'FTM', 'ATOM', 'OSMO', 'RUNE', 'CACAO', 'XRP',
	'DOGE', 'LTC', 'BCH', 'DASH', 'ZEC', 'ETC',
	// Wrapped / bridged
	'WAVAX', 'WBNB', 'WMATIC', 'WPOL', 'WFTM',
	// Major stablecoins (also in KNOWN_STABLECOINS but listed here for whitelist purposes)
	...KNOWN_STABLECOINS,
	// Major DeFi / governance
	'GRT', 'ENS', 'APE', 'SHIB', 'PEPE', 'WLD', 'IMX', 'RNDR', 'FET', 'OCEAN',
	'SAND', 'MANA', 'AXS', 'GALA', 'ILV', 'BLUR', 'PENDLE', 'ENA', 'ETHFI',
	'STX', 'INJ', 'TIA', 'SEI', 'SUI', 'APT', 'NEAR', 'FIL', 'AR',
	// LSTs / LRTs
	'STETH', 'RETH', 'CBETH', 'WSTETH', 'SWETH', 'EETH', 'WEETH', 'METH', 'RSETH',
	// FOX
	'FOX',
])

export type SpamLevel = 'confirmed' | 'possible' | null

export interface SpamResult {
	isSpam: boolean
	level: SpamLevel
	reason: string
}

// ── Heuristic helpers ────────────────────────────────────────────────

/** URL-like patterns in name or symbol — nearly always phishing */
const URL_PATTERN = /(?:\.[a-z]{2,6}(?:\/|$))|https?:|www\./i

/** Phishing action words that appear in scam token names */
const PHISHING_KEYWORDS = /\b(claim|visit|reward|bonus|airdrop|free|voucher|gift|redeem|activate|eligible)\b/i

/** Symbols should be short alphanumeric; these chars indicate scam */
const SUSPICIOUS_SYMBOL_CHARS = /[./:$!@#%^&*()+=\[\]{}|\\<>,?~`'"]/

/** Max reasonable symbol length — real tokens are 2-11 chars */
const MAX_SYMBOL_LENGTH = 11

/**
 * Detect whether a token is spam.
 *
 * Call with optional `userOverride` from the token_visibility DB table.
 * When a user override is present it takes absolute precedence.
 */
export function detectSpamToken(
	token: TokenBalance,
	userOverride?: 'visible' | 'hidden' | null,
): SpamResult {
	// ── Tier 0: User override — absolute precedence ──────────────────
	if (userOverride === 'visible') {
		return { isSpam: false, level: null, reason: 'User marked as safe' }
	}
	if (userOverride === 'hidden') {
		return { isSpam: true, level: 'confirmed', reason: 'User marked as hidden' }
	}

	const usd = token.balanceUsd ?? 0
	const sym = (token.symbol || '').toUpperCase()
	const name = token.name || ''

	// ── Tier 1: Name/symbol contains URL → CONFIRMED spam ────────────
	if (URL_PATTERN.test(name) || URL_PATTERN.test(token.symbol || '')) {
		return {
			isSpam: true,
			level: 'confirmed',
			reason: `Name/symbol contains URL — phishing token`,
		}
	}

	// ── Tier 2: Name contains phishing keywords → CONFIRMED spam ─────
	if (PHISHING_KEYWORDS.test(name)) {
		return {
			isSpam: true,
			level: 'confirmed',
			reason: `Name contains phishing keyword`,
		}
	}

	// ── Tier 3: Suspicious symbol characters or length → CONFIRMED ───
	if (SUSPICIOUS_SYMBOL_CHARS.test(token.symbol || '') || (token.symbol || '').length > MAX_SYMBOL_LENGTH) {
		return {
			isSpam: true,
			level: 'confirmed',
			reason: `Symbol has suspicious characters or is too long`,
		}
	}

	// ── Tier 4: Fake stablecoin (symbol matches but value way off) ───
	if (KNOWN_STABLECOINS.includes(sym) && usd < 0.50) {
		return {
			isSpam: true,
			level: 'confirmed',
			reason: `Fake ${sym} — real ${sym} is ~$1.00, this has $${usd.toFixed(2)}`,
		}
	}

	// ── Tier 5: Dust airdrop heuristic ───────────────────────────────
	// Huge quantity + near-zero unit price = classic airdrop spam
	// Exempt known legitimate tokens
	if (!KNOWN_LEGIT_SYMBOLS.has(sym)) {
		const qty = parseFloat(token.balance || '0')
		const price = token.priceUsd ?? 0

		if (qty > 1_000_000 && price < 0.0001) {
			return {
				isSpam: true,
				level: 'confirmed',
				reason: `Dust airdrop — ${qty.toLocaleString()} units at $${price.toFixed(8)}/unit`,
			}
		}

		// Moderate quantity + zero price but somehow has USD value (manipulated)
		if (qty > 10_000 && price === 0 && usd > 0) {
			return {
				isSpam: true,
				level: 'confirmed',
				reason: `Suspicious — large quantity with $0 price but non-zero value`,
			}
		}
	}

	// ── Tier 6: Low value → POSSIBLE spam ────────────────────────────
	if (usd < 1) {
		return {
			isSpam: true,
			level: 'possible',
			reason: `Low value ($${usd.toFixed(4)}) — common airdrop spam pattern`,
		}
	}

	// ── Clean — passed all checks ────────────────────────────────────
	return { isSpam: false, level: null, reason: 'Passed all spam checks' }
}

/**
 * Categorize an array of tokens using detectSpamToken.
 *
 * @param tokens      - token array from ChainBalance.tokens
 * @param overrides   - Map<caip, 'visible'|'hidden'> from DB
 * @returns { clean, spam, zeroValue } — mutually exclusive buckets
 */
export function categorizeTokens(
	tokens: TokenBalance[],
	overrides?: Map<string, 'visible' | 'hidden'>,
) {
	const clean: TokenBalance[] = []
	const spam: TokenBalance[] = []
	const zeroValue: TokenBalance[] = []

	for (const t of tokens) {
		const override = overrides?.get(t.caip?.toLowerCase()) ?? null
		const result = detectSpamToken(t, override)

		if (result.isSpam) {
			spam.push(t)
		} else if ((t.balanceUsd ?? 0) === 0) {
			zeroValue.push(t)
		} else {
			clean.push(t)
		}
	}

	return { clean, spam, zeroValue }
}
