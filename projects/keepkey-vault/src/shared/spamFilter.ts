/**
 * Token filter — discovery-list based.
 * Any token whose CAIP is not in the pioneer-discovery catalog is treated as
 * unknown/spam and hidden. User overrides take absolute precedence.
 */

import type { TokenBalance } from './types'
import { assetData } from '@pioneer-platform/pioneer-discovery'

// Build once at module load for O(1) lookups.
const _arr: Array<{ assetId: string }> = Array.isArray(assetData)
	? assetData
	: Object.values(assetData as object)
const DISCOVERY_SET = new Set<string>(_arr.map(a => a.assetId.toLowerCase()))

export type SpamLevel = 'confirmed' | 'possible' | null

export interface SpamResult {
	isSpam: boolean
	level: SpamLevel
	reason: string
}

/**
 * Returns whether a token should be hidden.
 * User overrides (from token_visibility DB table) take absolute precedence.
 * All other tokens are checked against the discovery catalog.
 */
export function detectSpamToken(
	token: TokenBalance,
	userOverride?: 'visible' | 'hidden' | null,
): SpamResult {
	if (userOverride === 'visible') return { isSpam: false, level: null, reason: 'User marked as safe' }
	if (userOverride === 'hidden') return { isSpam: true, level: 'confirmed', reason: 'User marked as hidden' }

	const caip = (token.caip || '').toLowerCase()
	if (!caip) return { isSpam: false, level: null, reason: 'No CAIP' }

	// Synthetic tokens injected by the vault that will never appear in the discovery catalog.
	if (caip.includes('/orchard:')) return { isSpam: false, level: null, reason: 'Synthetic shielded token' }

	// Discovery emits BSC tokens as /bep20:; Pioneer portfolio returns /erc20: for the same assets.
	const lookupCaip = caip.replace(/^eip155:56\/erc20:/, 'eip155:56/bep20:')
	if (DISCOVERY_SET.has(lookupCaip)) return { isSpam: false, level: null, reason: 'In discovery catalog' }

	return { isSpam: true, level: 'confirmed', reason: 'Not in discovery catalog' }
}

/**
 * Split a token array into clean / spam / zeroValue buckets.
 * Only confirmed spam is auto-hidden.
 */
export function categorizeTokens(
	tokens: TokenBalance[],
	overrides?: Map<string, 'visible' | 'hidden'>,
) {
	const clean: TokenBalance[] = []
	const spam: TokenBalance[] = []
	const zeroValue: TokenBalance[] = []

	for (const t of tokens) {
		const override = overrides?.get((t.caip || '').toLowerCase()) ?? null
		const result = detectSpamToken(t, override)

		if (result.isSpam && result.level === 'confirmed') {
			spam.push(t)
		} else if ((t.balanceUsd ?? 0) === 0) {
			zeroValue.push(t)
		} else {
			clean.push(t)
		}
	}

	return { clean, spam, zeroValue }
}
