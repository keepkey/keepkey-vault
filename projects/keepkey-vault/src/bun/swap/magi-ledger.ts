/**
 * The user's balance inside Magi (VSC), separate from their Hive account.
 *
 * A Hive-out swap deposits first and swaps second. Between the two, and after
 * any failure, the funds sit here, in the user's own Magi balance. This module
 * is how the vault sees that balance, confirms a deposit landed, and builds
 * the withdrawal back to the Hive account.
 *
 * Facts (Skatehive Coder, SDK 0.0.3 + mainnet, 2026-11-26):
 *  - Deposit credit lands in the same Hive block as the transfer; indexing
 *    takes ~3–6 s. `client.getBalance` reads the Hive L1 account, NOT this.
 *  - Balances are integers with 3 implied decimals (3710 = 3.710).
 *  - Withdraw is custom_json id "vsc.withdraw", ACTIVE key, asset lowercase,
 *    amount with 3 decimals; it completes in ~10 blocks (~30 s).
 */
import type { HiveOpTuple } from '../txbuilder/hive-ops'

export type MagiHiveAsset = 'HIVE' | 'HBD'

/** Milli-units (3 decimals). */
export interface MagiBalance { hive: bigint; hbd: bigint; blockHeight?: number }

export interface MagiWithdrawal {
	id: string
	asset: MagiHiveAsset
	amount: bigint
	to: string
	status: string
	blockHeight?: number
}

/** Everything the swap flow needs from Magi's ledger. Swappable in tests. */
export interface MagiLedger {
	getBalance(username: string): Promise<MagiBalance>
	/** True once the deposit transfer with this Hive txid is in the ledger. */
	isDepositCredited(hiveTxId: string): Promise<boolean>
	listWithdrawals(username: string): Promise<MagiWithdrawal[]>
	buildWithdraw(params: { username: string; asset: MagiHiveAsset; amount: bigint }): HiveOpTuple
}

export const MAGI_NET_ID = 'vsc-mainnet'

/** "3.710" from 3710n. */
export function formatMilli(milli: bigint): string {
	const neg = milli < 0n
	const v = neg ? -milli : milli
	return `${neg ? '-' : ''}${v / 1000n}.${(v % 1000n).toString().padStart(3, '0')}`
}

function toMilli(v: unknown): bigint {
	if (typeof v === 'bigint') return v
	if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
	if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
	// Some ledger rows may carry a decimal string ("0.087"); accept it too.
	if (typeof v === 'string' && /^\d+\.\d{1,3}$/.test(v)) {
		const [i, f] = v.split('.')
		return BigInt(i!) * 1000n + BigInt(f!.padEnd(3, '0'))
	}
	return 0n
}

/** The withdrawal op. Pure: the device clear-signs it via HiveSignOperations. */
export function buildMagiWithdrawOp(params: { username: string; asset: MagiHiveAsset; amount: bigint }): HiveOpTuple {
	if (!/^[a-z][a-z0-9.-]{2,15}$/.test(params.username)) throw new Error('Invalid Hive account name')
	if (params.amount <= 0n) throw new Error('Withdrawal amount must be greater than zero')
	const did = `hive:${params.username}`
	return ['custom_json', {
		required_auths: [params.username],
		required_posting_auths: [],
		id: 'vsc.withdraw',
		json: JSON.stringify({
			from: did,
			to: did,
			amount: formatMilli(params.amount),
			asset: params.asset.toLowerCase(),
			net_id: MAGI_NET_ID,
		}),
	}]
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** GraphQL ledger over Magi's API nodes, falling through on network errors. */
export function createGraphqlMagiLedger(opts: { gqlUrls: readonly string[]; fetchImpl?: Fetch; timeoutMs?: number }): MagiLedger {
	const doFetch = opts.fetchImpl ?? fetch
	const timeoutMs = opts.timeoutMs ?? 8_000

	async function gql<T>(query: string): Promise<T> {
		let lastErr: unknown
		for (const base of opts.gqlUrls) {
			try {
				const resp = await doFetch(`${base.replace(/\/$/, '')}/api/v1/graphql`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ query }),
					signal: AbortSignal.timeout(timeoutMs),
				})
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
				const data: any = await resp.json()
				if (data?.errors?.length) throw new Error(data.errors[0]?.message || 'GraphQL error')
				return data.data as T
			} catch (e) {
				lastErr = e
			}
		}
		throw new Error(`Magi API unreachable: ${(lastErr as any)?.message || 'unknown error'}`)
	}

	// Values are interpolated into the query: restrict them to their alphabets.
	const account = (u: string) => {
		if (!/^[a-z][a-z0-9.-]{2,15}$/.test(u)) throw new Error('Invalid Hive account name')
		return `hive:${u}`
	}

	return {
		async getBalance(username) {
			const d = await gql<any>(`query { getAccountBalance(account:"${account(username)}") { hbd hive block_height } }`)
			const b = d?.getAccountBalance ?? {}
			return { hive: toMilli(b.hive), hbd: toMilli(b.hbd), blockHeight: b.block_height ?? undefined }
		},
		async isDepositCredited(hiveTxId) {
			if (!/^[0-9a-f]{40}$/i.test(hiveTxId)) throw new Error('Invalid Hive transaction id')
			const d = await gql<any>(`query { findLedgerTXs(filterOptions:{byTxId:"${hiveTxId.toLowerCase()}"}) { id type asset amount owner block_height } }`)
			const rows = d?.findLedgerTXs
			return Array.isArray(rows) && rows.length > 0
		},
		async listWithdrawals(username) {
			const d = await gql<any>(`query { findLedgerActions(filterOptions:{byAccount:"${account(username)}", byTypes:["withdraw"]}) { id type asset amount to status block_height } }`)
			const rows: any[] = Array.isArray(d?.findLedgerActions) ? d.findLedgerActions : []
			return rows.map(r => ({
				id: String(r.id),
				asset: String(r.asset).toUpperCase() === 'HBD' ? 'HBD' : 'HIVE',
				amount: toMilli(r.amount),
				to: String(r.to ?? ''),
				status: String(r.status ?? ''),
				blockHeight: r.block_height ?? undefined,
			}))
		},
		buildWithdraw: buildMagiWithdrawOp,
	}
}
