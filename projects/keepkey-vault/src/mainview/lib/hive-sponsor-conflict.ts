/**
 * Pioneer answers a sponsored-account conflict with HTTP 409 and only a prose
 * `error` — no machine code. Three different limits share that status:
 *
 *   - the username was taken between the availability check and the create
 *     ("Username already registered");
 *   - this KeepKey's ETH address already claimed its sponsored account
 *     ("This ETH address already has a sponsored Hive account");
 *   - this vault installation (the Pioneer query key = "client") already
 *     sponsored one, whatever KeepKey asks.
 *
 * Production currently folds the last two into one sentence ("This ETH address
 * or client has already claimed a sponsored Hive account"), so that text maps
 * to `eth-or-client`: the copy must not claim it was the device when it may be
 * this installation. Anything unrecognized falls back to `name-taken`, the
 * historical behaviour (the user can always pick another name).
 */
export type HiveSponsorConflict = 'name-taken' | 'eth-address' | 'client' | 'eth-or-client'

const MENTIONS_CLIENT = /\bclient\b|\binstall(ation)?\b|query[\s_-]?key|api[\s_-]?key/i
const MENTIONS_ETH = /\beth\b|ethereum|\baddress\b/i

export function classifyHiveSponsorConflict(error: string | null | undefined): HiveSponsorConflict {
	const text = error ?? ''
	const client = MENTIONS_CLIENT.test(text)
	const eth = MENTIONS_ETH.test(text)
	if (client && eth) return 'eth-or-client'
	if (client) return 'client'
	if (eth) return 'eth-address'
	return 'name-taken'
}

/** Only the installation limit can be met with an account the user already owns. */
export const offersExistingAccount = (conflict: HiveSponsorConflict | null): boolean =>
	conflict === 'client' || conflict === 'eth-or-client'
