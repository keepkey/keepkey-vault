/**
 * Token Spam Filter — 3-tier detection adapted from keepkey-vault v10.
 *
 * Detection tiers:
 *  1. User override (SQLite-persisted 'visible'/'hidden') — bypasses all detection
 *  2. Value >= $1 → NOT spam
 *  3. Known stablecoin symbol with value < $0.50 → CONFIRMED spam
 *  4. Value < $1 → POSSIBLE spam (likely worthless airdrop)
 */

import type { TokenBalance } from './types'

export const KNOWN_STABLECOINS = [
	'USDT', 'USDC', 'DAI', 'BUSD', 'UST', 'TUSD', 'USDD', 'USDP', 'GUSD', 'PYUSD',
	'FRAX', 'LUSD', 'SUSD', 'ALUSD', 'FEI', 'MIM', 'DOLA', 'AGEUR', 'EURT', 'EURS',
]

export type SpamLevel = 'confirmed' | 'possible' | null

export interface SpamResult {
	isSpam: boolean
	level: SpamLevel
	reason: string
}

/**
 * Detect whether a token is spam based on its USD value and symbol.
 *
 * Call with optional `userOverride` from the token_visibility DB table.
 * When a user override is present it takes absolute precedence.
 */
export function detectSpamToken(
	token: TokenBalance,
	userOverride?: 'visible' | 'hidden' | null,
): SpamResult {
	// User override — absolute precedence
	if (userOverride === 'visible') {
		return { isSpam: false, level: null, reason: 'User marked as safe' }
	}
	if (userOverride === 'hidden') {
		return { isSpam: true, level: 'confirmed', reason: 'User marked as hidden' }
	}

	const usd = token.balanceUsd ?? 0

	// Tier 1: significant value → NOT spam
	if (usd >= 1) {
		return { isSpam: false, level: null, reason: 'Has significant USD value' }
	}

	// Tier 2: fake stablecoin
	const sym = (token.symbol || '').toUpperCase()
	if (KNOWN_STABLECOINS.includes(sym) && usd < 0.50) {
		return {
			isSpam: true,
			level: 'confirmed',
			reason: `Fake ${sym} — real ${sym} is ~$1.00, this has $${usd.toFixed(2)}`,
		}
	}

	// Tier 3: low value → possible spam
	return {
		isSpam: true,
		level: 'possible',
		reason: `Low value ($${usd.toFixed(4)}) — common airdrop spam pattern`,
	}
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
