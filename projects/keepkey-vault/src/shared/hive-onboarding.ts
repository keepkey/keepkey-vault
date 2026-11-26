/**
 * Hive onboarding without the sponsor (KEEPKEY-187 / KEEPKEY-188).
 *
 * When Pioneer's sponsor refuses (any 409, or an error) the user is never
 * stuck. Two self-serve paths, both signed OUTSIDE the vault by a wallet that
 * already holds a Hive key (Hive Keychain, HiveSigner, …):
 *
 *  A) Pay for your own account — someone with HIVE (the user or a friend)
 *     signs `account_create` (or `create_claimed_account` when they hold an
 *     account-creation token) that installs this KeepKey's four public keys.
 *  B) Bring your Hive account — the account's CURRENT active key signs an
 *     `account_update` that swaps active, posting and memo to this KeepKey's
 *     keys. Owner stays as it is: the old owner key / master password remains
 *     the recovery path. Rotating owner is a separate, optional step.
 *
 * The vault never sees a private key here. It only builds the operation and
 * hands it over as a HiveSigner link, a hive-uri QR, or JSON.
 *
 * Wallet support (Skate Wallet team, 2026-11-26): the Keychain / Skate Wallet
 * EXTENSION does not open account_create or account_update from hive:// links
 * (its "keychainify" handles only transfer-type ops), so HiveSigner is the
 * primary route. Keychain MOBILE QR support for these ops is unconfirmed.
 *
 * Formats (hive-uri README, openhive-network/hive-uri; HiveSigner docs,
 * hivesigner.com/docs/sign-links):
 *   hive://sign/op/<b64u(JSON op)>              — op = [name, params]
 *   https://hivesigner.com/sign/op/<same b64u>  — HiveSigner picks the key from the op
 *   b64u = base64 with "+"→"-", "/"→"_" and "=" padding → "." (padding kept)
 */

export type HiveRoleKeys = { owner: string; active: string; posting: string; memo: string }
export type HiveAuthority = {
	weight_threshold: number
	account_auths: [string, number][]
	key_auths: [string, number][]
}
/** The parts of condenser_api.get_accounts the two paths need. */
export type HiveAccountAuthorities = {
	name: string
	owner: HiveAuthority
	active: HiveAuthority
	posting: HiveAuthority
	memo_key: string
	json_metadata: string
	posting_json_metadata?: string
	/** Account-creation tokens (ACT) held, from condenser_api.get_accounts. */
	pending_claimed_accounts?: number
	/** Liquid balance, e.g. "12.345 HIVE". */
	balance?: string
}
export type HiveOperation = [string, Record<string, unknown>]

/** Current chain default; the backend reads the live value (get_chain_properties). */
export const DEFAULT_ACCOUNT_CREATION_FEE = '3.000 HIVE'

/**
 * Hive account-name rules (hived `is_valid_account_name`): 3–16 chars total,
 * dot-separated segments of ≥3 chars, each starting with a letter, then
 * lowercase letters, digits or hyphens, never ending with a hyphen.
 */
export function isValidHiveAccountName(name: string): boolean {
	if (typeof name !== 'string' || name.length < 3 || name.length > 16) return false
	return name.split('.').every(seg => /^[a-z][a-z0-9-]{1,}[a-z0-9]$/.test(seg) && !seg.includes('--'))
}

/** Normalizes user input "@Name " → "name". */
export const normalizeHiveAccountName = (input: string): string => input.trim().replace(/^@/, '').toLowerCase()

/** Single-key authority: this KeepKey's key alone satisfies it. */
export const singleKeyAuthority = (pubkey: string, accountAuths: [string, number][] = []): HiveAuthority => ({
	weight_threshold: 1,
	account_auths: sortAuths(accountAuths),
	key_auths: [[pubkey, 1]],
})

// account_auths must be sorted by name or the node rejects the authority
// ("authority must be sorted"). key_auths sort by compressed-key bytes, not the
// STM string — irrelevant here because every authority built has one key.
const sortAuths = <T extends [string, number]>(auths: T[]): T[] =>
	auths.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

/** get_accounts sometimes returns weights as strings; re-sent ops need numbers. */
export function normalizeAuthority(raw: any): HiveAuthority {
	const pairs = (list: any): [string, number][] =>
		Array.isArray(list) ? list.map((p: any) => [String(p?.[0] ?? ''), Number(p?.[1] ?? 0)] as [string, number]) : []
	return {
		weight_threshold: Number(raw?.weight_threshold ?? 1),
		account_auths: sortAuths(pairs(raw?.account_auths)),
		key_auths: pairs(raw?.key_auths),
	}
}

/** condenser_api.get_accounts row → the fields the two paths use. */
export function parseAccountAuthorities(raw: any): HiveAccountAuthorities {
	return {
		name: String(raw?.name ?? ''),
		owner: normalizeAuthority(raw?.owner),
		active: normalizeAuthority(raw?.active),
		posting: normalizeAuthority(raw?.posting),
		memo_key: String(raw?.memo_key ?? ''),
		json_metadata: typeof raw?.json_metadata === 'string' ? raw.json_metadata : '',
		posting_json_metadata: typeof raw?.posting_json_metadata === 'string' ? raw.posting_json_metadata : undefined,
		pending_claimed_accounts: Number(raw?.pending_claimed_accounts ?? 0),
		balance: typeof raw?.balance === 'string' ? raw.balance : undefined,
	}
}

/** Path A: the payer spends the creation fee in HIVE. */
export function buildAccountCreateOp({ creator, newAccountName, keys, fee = DEFAULT_ACCOUNT_CREATION_FEE }: {
	creator: string; newAccountName: string; keys: HiveRoleKeys; fee?: string
}): HiveOperation {
	return ['account_create', {
		fee,
		creator,
		new_account_name: newAccountName,
		owner: singleKeyAuthority(keys.owner),
		active: singleKeyAuthority(keys.active),
		posting: singleKeyAuthority(keys.posting),
		memo_key: keys.memo,
		json_metadata: '',
	}]
}

/** Path A, alternative: the payer spends one account-creation token (ACT), no HIVE. */
export function buildCreateClaimedAccountOp({ creator, newAccountName, keys }: {
	creator: string; newAccountName: string; keys: HiveRoleKeys
}): HiveOperation {
	return ['create_claimed_account', {
		creator,
		new_account_name: newAccountName,
		owner: singleKeyAuthority(keys.owner),
		active: singleKeyAuthority(keys.active),
		posting: singleKeyAuthority(keys.posting),
		memo_key: keys.memo,
		json_metadata: '',
		extensions: [],
	}]
}

export type KeyRotationOptions = {
	/** Keep accounts (apps) authorized on posting, e.g. ["ecency.app", 1]. */
	keepPostingAccountAuths: boolean
	/** Keep accounts authorized on active (rare: multisig / services). */
	keepActiveAccountAuths: boolean
}

/**
 * Account authorities are only carried over from a plain single-signature
 * authority (threshold 1). From a multisig (threshold > 1) the new authority
 * has threshold 1, so an account that used to need a co-signer would gain
 * full control alone — those are dropped instead.
 */
const carriedAccountAuths = (auth: HiveAuthority, keep: boolean): [string, number][] =>
	keep && auth.weight_threshold === 1 ? auth.account_auths : []

/**
 * Path B: `account_update` without `owner`, so it needs only the account's
 * ACTIVE authority (hived get_required_active_authorities: `if( !owner )`).
 * json_metadata is passed through unchanged; posting_json_metadata is not a
 * field of account_update, so it is left untouched.
 */
export function buildKeyRotationOp(account: HiveAccountAuthorities, keys: HiveRoleKeys, opts: KeyRotationOptions): HiveOperation {
	return ['account_update', {
		account: account.name,
		active: singleKeyAuthority(keys.active, carriedAccountAuths(account.active, opts.keepActiveAccountAuths)),
		posting: singleKeyAuthority(keys.posting, carriedAccountAuths(account.posting, opts.keepPostingAccountAuths)),
		memo_key: keys.memo,
		json_metadata: account.json_metadata ?? '',
	}]
}

/**
 * Optional, separate owner rotation. Carrying `owner` makes hived require the
 * OWNER authority (master password / owner key, e.g. through HiveSigner) —
 * after it, the old master password no longer recovers the account.
 * memo_key is a required field of account_update, so it is sent as the
 * KeepKey memo key (the same value path B sets).
 */
export function buildOwnerRotationOp(account: HiveAccountAuthorities, keys: HiveRoleKeys): HiveOperation {
	return ['account_update', {
		account: account.name,
		owner: singleKeyAuthority(keys.owner),
		memo_key: keys.memo,
		json_metadata: account.json_metadata ?? '',
	}]
}

export type KeyRotationPlan = {
	alreadyOnKeepKey: boolean
	activeKeys: number
	postingKeys: number
	memoChanges: boolean
	ownerOnKeepKey: boolean
	postingApps: [string, number][]
	activeAccounts: [string, number][]
	/** Account authorities that cannot be carried over (multisig source). */
	droppedForMultisig: string[]
}

/** What the rotation changes, for the review list. */
export function planKeyRotation(account: HiveAccountAuthorities, keys: HiveRoleKeys): KeyRotationPlan {
	const only = (auth: HiveAuthority, key: string) => auth.key_auths.length === 1 && auth.key_auths[0][0] === key
	const dropped = [account.active, account.posting]
		.filter(a => a.weight_threshold !== 1)
		.flatMap(a => a.account_auths.map(([name]) => name))
	return {
		alreadyOnKeepKey: only(account.active, keys.active) && only(account.posting, keys.posting) && account.memo_key === keys.memo,
		activeKeys: account.active.key_auths.length,
		postingKeys: account.posting.key_auths.length,
		memoChanges: account.memo_key !== keys.memo,
		ownerOnKeepKey: account.owner.key_auths.some(([k]) => k === keys.owner),
		postingApps: account.posting.account_auths,
		activeAccounts: account.active.account_auths,
		droppedForMultisig: [...new Set(dropped)],
	}
}

/** Base64 of the UTF-8 bytes with the hive-uri URL-safe alphabet ("=" → "."). */
export function b64u(text: string): string {
	const bytes = new TextEncoder().encode(text)
	let binary = ''
	for (const b of bytes) binary += String.fromCharCode(b)
	return btoa(binary).replace(/[+/=]/g, m => (m === '+' ? '-' : m === '/' ? '_' : '.'))
}

/** hive-uri (github.com/openhive-network/hive-uri): `?s=<account>` names the signer.
 *  Without it Hive Keychain mobile shows "@undefined" and can't pick the key. */
export const hiveSignUri = (op: HiveOperation, signer?: string): string =>
	`hive://sign/op/${b64u(JSON.stringify(op))}${signer ? `?s=${encodeURIComponent(signer)}` : ''}`
export const hiveSignerUrl = (op: HiveOperation): string => `https://hivesigner.com/sign/op/${b64u(JSON.stringify(op))}`
/** Pretty JSON for "copy operation" (Keychain / any broadcast tool). */
export const operationJson = (op: HiveOperation): string => JSON.stringify(op, null, 2)
