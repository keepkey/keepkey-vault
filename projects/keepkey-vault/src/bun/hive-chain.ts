/**
 * Direct, read-only Hive node queries for the self-serve onboarding paths
 * (KEEPKEY-187/188). Pioneer exposes no account-by-name authorities nor chain
 * properties, so the vault reads them from public API nodes — the same set
 * Pioneer's hive controller uses — with per-node timeout and failover.
 * Nothing here signs or broadcasts.
 */
import { DEFAULT_ACCOUNT_CREATION_FEE, isValidHiveAccountName, parseAccountAuthorities, type HiveAccountAuthorities } from '../shared/hive-onboarding'

export const HIVE_API_NODES = ['https://api.hive.blog', 'https://api.deathwing.me', 'https://api.openhive.network']
const TIMEOUT_MS = 6000

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export async function hiveRpc<T = any>(method: string, params: unknown, fetchImpl: Fetch = fetch): Promise<T> {
	let last = ''
	for (const node of HIVE_API_NODES) {
		try {
			const res = await fetchImpl(node, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
			const json: any = await res.json()
			if (!json?.error) return json.result as T
			last = `${node}: ${json.error.message ?? 'error'}`
		} catch (e: any) {
			last = `${node}: ${e?.message ?? e}`
		}
	}
	throw new Error(`All Hive nodes failed for ${method} (${last})`)
}

/** Authorities, metadata, ACT count and balance for one account, or null when it doesn't exist. */
export async function lookupHiveAccount(name: string, fetchImpl: Fetch = fetch): Promise<HiveAccountAuthorities | null> {
	if (!isValidHiveAccountName(name)) throw new Error('Invalid Hive account name')
	const rows = await hiveRpc<any[]>('condenser_api.get_accounts', [[name]], fetchImpl)
	const row = Array.isArray(rows) ? rows.find(r => r?.name === name) : undefined
	return row ? parseAccountAuthorities(row) : null
}

/** Witness-median account_creation_fee, e.g. "3.000 HIVE"; witnesses can change it. */
export async function hiveAccountCreationFee(fetchImpl: Fetch = fetch): Promise<string> {
	const props = await hiveRpc<any>('condenser_api.get_chain_properties', [], fetchImpl)
	const fee = props?.account_creation_fee
	return typeof fee === 'string' && /^\d+\.\d{3} HIVE$/.test(fee) ? fee : DEFAULT_ACCOUNT_CREATION_FEE
}
